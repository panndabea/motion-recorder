# MotionRecorder

Record your own body movement with a webcam, retarget it live onto the Quaternius
mannequin, and export it as a portable, reproducible animation (versioned JSON or
a standalone GLB) that replays identically on a fresh instance of the same rig.

Everything runs in the browser. Webcam frames never leave the device: pose
inference runs locally with MediaPipe (WASM/WebGL); only the model file may be
fetched from Google's CDN if it is not present locally.

![screenshot](docs/screenshot.png)

## Quick start

```bash
npm install            # also copies the MediaPipe WASM runtime into public/mediapipe/wasm
npm run fetch-model    # optional: store pose_landmarker_full.task locally (otherwise loaded from CDN)
npm run dev            # http://localhost:5173
```

Requirements: Node 20+, a Chromium-based browser or Firefox/Safari with WebGL2.
Camera access needs a secure context (`localhost` or HTTPS).

No webcam? Open `http://localhost:5173/?source=synthetic` – a deterministic
synthetic pose stream (generated from the mannequin's own clips) replaces the
camera so the full pipeline can be tried and tested. While calibrating, the
synthetic source holds its neutral first frame (like a person standing still).

## Using it

1. **Start camera** – grant permission, pick a camera if you have several. The
   mirrored preview shows the detected skeleton. Stand 2–3 m away so your whole
   body is visible.
2. **Calibrate** – stand upright, face the camera, arms relaxed, hold still for
   ~1.5 s. Calibration captures your neutral torso/head orientation so it maps
   onto the mannequin's rest pose. If your legs are not visible it calibrates
   upper body only and the legs stay at rest. Recalibrate anytime.
3. **Ready** – the mannequin follows you live.
4. **Record / Stop** – name the take first (or rename it later). Takes are stored
   in IndexedDB and survive reloads.
5. **Playback** – Play/Pause, Restart, Loop and timeline scrubbing. While a take is
   playing, live tracking does not drive the bones. *Back to live* returns to
   tracking.
6. **Export JSON / Export GLB / Import…** – import accepts both formats.

Modes shown top-right: Camera Disabled → Tracking → Calibrating → Ready →
Recording / Playback.

## Architecture

```
webcam ─► MediaPipe PoseLandmarker (VIDEO mode, GPU→CPU fallback, adaptive frame stride)
          │  33 image + world landmarks with visibility
          ▼
     LandmarkFilter (One-Euro per joint, confidence gating)
          ▼
     Calibrator ──► CalibrationData (neutral pelvis/chest/head offsets, legs tracked?)
          ▼
     Retargeter (rig-specific, quaternion only)
          │  local bone rotations + vertical hips offset
          ▼
     QuaternionSmoother ─► MotionEngine.update() ─► mannequin bones (Three.js)
                                    │                    ▲
                                    ├─► MotionRecorder ──┘ (samples final local pose)
                                    └─► MotionPlayer (AnimationClip, deterministic sampling)
```

| Path | Responsibility |
| --- | --- |
| `src/rig/rigSpec.ts` | Bone mapping for this exact rig (`DEF-*` Rigify names), driven bones, target height |
| `src/rig/rigDefinition.ts` | Rest hierarchy, forward kinematics, rig signature |
| `src/rig/retargeting.ts` | Landmarks → local quaternions: torso frames from hips/shoulders, swing-twist limb aiming in the parent's frame, hinge planes to fix forearm/shin twist, occlusion hold and release-to-rest, foot grounding |
| `src/rig/poseFiltering.ts` | One-Euro landmark filter, quaternion smoothing |
| `src/tracking/` | Camera access, MediaPipe wrapper, calibration, synthetic source |
| `src/recording/` | Motion format + validation, recorder (resamples to a fixed fps), playback |
| `src/export/`, `src/import/` | JSON and GLB export/import |
| `src/engine/MotionEngine.ts` | Single owner of the bones each frame; mode state machine |
| `src/components/`, `src/viewport/` | React UI, React Three Fiber viewport |

### Retargeting approach

- Only **rotations** are transferred; positions of the user are never copied to
  bones, so bone lengths and the mannequin's proportions are preserved.
- MediaPipe world landmarks are converted to the mannequin's frame (+Y up, +Z
  forward). The pelvis orientation comes from the hip line and the hip→shoulder
  axis, the chest from the shoulder line, the head from ears/eyes/nose.
- Each limb segment is aimed by the shortest-arc rotation from its rest direction
  to the observed direction, expressed in the parent's (already solved) frame.
  The elbow/knee bend plane determines the twist so upper arms and thighs do not
  spin.
- Joints whose landmarks have low visibility hold their last pose for a while
  and then ease back to rest.
- Root motion: no horizontal translation is invented. With *Foot grounding* on,
  the hips are lowered by the amount the legs bend so the feet stay on the
  floor (crouches look right); otherwise the hips stay in place.

## Motion file format (JSON, version 1)

```jsonc
{
  "format": "motion-recorder",
  "version": 1,
  "name": "My First Animation",
  "createdAt": "2026-11-11T10:00:00.000Z",
  "duration": 2.6,                // seconds
  "fps": 30,                      // every track is sampled on the same uniform time base
  "frameCount": 79,
  "space": "local",               // relative to the parent bone, like glTF animation channels
  "quaternionOrder": "xyzw",
  "interpolation": "linear",      // slerp for rotations
  "rig": {
    "id": "quaternius-ual-mannequin",
    "signature": "…",             // hash of bone names + parent links
    "boneCount": 53,
    "upAxis": "+Y", "forwardAxis": "+Z", "units": "rig", "rawHeight": 1.83,
    "bones": [ { "name": "DEF-hips", "parent": "root", "translation": [...], "rotation": [...], "scale": [...] }, … ]
  },
  "tracks": [
    { "bone": "DEF-upper_arm.L", "property": "rotation",    "times": [0, 0.0333, …], "values": [[x, y, z, w], …] },
    { "bone": "DEF-hips",        "property": "translation", "times": [0, 0.0333, …], "values": [[x, y, z], …] }
  ],
  "meta": { "source": "webcam", "rootMotion": "vertical-grounded" }
}
```

Bone names are the original glTF node names. The rest pose of every bone is
embedded so a consumer can rebuild untracked bones without the GLB. Quaternions
are kept in a continuous hemisphere between keys. A sample file is in
[`examples/`](examples/).

**Import validation** (`src/recording/motionFormat.ts`): format and version,
rig id and skeleton signature (rejected if they do not match the loaded rig),
track structure, strictly increasing finite times within the duration, value
arity, finite numbers, unit-length quaternions (renormalised within tolerance,
rejected otherwise), size limits. Tracks for unknown bones are dropped with a
warning. Files are parsed with `JSON.parse` only; nothing is executed.

## GLB export

`Export GLB` writes the mannequin (mesh, skin, skeleton) plus exactly one
animation – the recording – using the original node hierarchy, so it opens in
Blender, three.js, Babylon or any glTF viewer. The 46 library clips are removed.
Every joint gets a channel (untracked joints hold their rest pose), rotations as
local `rotation` channels, hips as `translation`, linear interpolation, original
timing.

Before the file is offered for download, the app re-imports it in memory onto a
fresh mannequin and compares it to the recording; a failed check aborts the
export. Unit tests additionally run the Khronos glTF validator (0 errors) and
replay the re-imported clip on a fresh rig instance.

## AI Director Studio (`/director`)

A second workspace in the same app. Open it with **AI Director Studio →** in the MotionRecorder header, or go to `/director`. **← Back to MotionRecorder** returns to `/recorder`. Switching uses client-side routing (no reload). The recorder releases the webcam when you leave it, and its takes stay in IndexedDB. The Director never touches the camera.

### What you can do
- **Stage:** the mannequin, a table, a glass, the ground, a camera and a key light, each with a stable id (`actor`, `table`, `glass`, ...). Select objects in the hierarchy or on the stage. Move them with the gizmo or in the inspector. Orbit the camera; **Reset camera** restores the saved view.
- **Direct with text:** for example *"Walk to the table, pick up the glass, look around nervously and put it back on the table."* Follow-ups edit only the actions they name:
  - *"Do it more slowly."* / *"Make him more cautious."*
  - *"Look around before putting down the glass."*
  - *"Pause before releasing the glass."* / *"Move the hesitation to the end."*
  - *"Make the walk more exaggerated."*
  - Timing: *"Take at least 8 seconds."*, *"Make the entire movement last 12 seconds."*, *"Complete the action in exactly 5 seconds."*, *"Finish the walk in at most 3 seconds."*, *"Actually, make it twice as slow."*, *"Slow down the last part."*, *"Spend more time looking around."*, *"Pause for 2 seconds before releasing the glass."*, *"Look around for 2 seconds before placing it."*, *"Make the walking faster but the placing slower."*
  - Simple German also works, e.g. *"Geh zum Tisch und nimm das Glas."*
- **Timeline:** lanes for Actor Root, Body Motion, Head/Gaze, Right/Left Arm, Object Interaction, Glass Transform and Events (attach/release). You can play, pause, loop, scrub, and zoom. Click a clip to inspect it and edit its speed, duration, style, bend or amplitude; move it earlier or later, delete it, or insert a pause after it.
- **Conversational timing:** "at least" only extends what is too short (a 10 s take stays 10 s), "at most" only shortens, "exactly"/"last N seconds" sets the duration, "twice as slow" scales it. "It", "the movement" and "the action" mean the selected clip, otherwise what the previous instruction created or changed; "the whole sequence" and "the first/last part" mean what they say. If that is still ambiguous the Director asks which part you mean, and a short answer ("the walk") completes the original instruction. A request that changes nothing says "No change" and why; an impossible one (e.g. the whole scene in 1 s) is rejected with the minimum it needs.
- **Undo/Redo** covers prompts, timeline edits and object moves.
- **Projects:** the current project is autosaved in IndexedDB (`director-studio` database, separate from recordings). **Save** downloads a versioned `*.director.json`; **Open** loads one after validation; **New** starts an empty scene. A project stores the scene, the structured action list (with ids), the chat with the applied structured commands, the camera and settings. Reopening a project recomposes the performance from the stored actions and never re-interprets the chat text.
- **Export:**
  - **Motion JSON:** the actor motion in the MotionRecorder format, `meta.source: "director"`, root motion on the `root` bone.
  - **Actor GLB:** the mannequin with the baked animation, re-imported as a check before download.
  - **Scene GLB:** mannequin, table, ground and the glass with its own baked transform animation, also re-imported as a check.
  - **Send to MotionRecorder:** saves the baked take into the recorder's library and switches workspaces.

### How it works
1. **Interpret:** `src/director/ai/commandParser.ts` is a deterministic, rule-based interpreter that turns text into structured commands (`create_sequence`, `append_actions`, `insert_actions`, `modify_actions`, `move_actions`, `delete_actions`, and the timing/style edits `set_duration`, `set_min_duration`, `set_max_duration`, `scale_duration`, `insert_pause`, `modify_style`). Contextual references (`scope: context | sequence | first_part | last_part`) are resolved to concrete action ids by `ai/editContext.ts` before anything is applied; `ai/directorSession.ts` runs the whole turn. It is **not** a language model. Phrases it cannot map are reported as unsupported, and no motion is invented for them.
2. **Validate:** `commandSchema.ts` checks every command: action types (`walk_to`, `turn`, `reach`, `grip`, `lift`, `place`, `release`, `look_at`, `look_around`, `pause`, `bend`, `idle`, `sit`, `stand_up`), object references, value ranges and operations. Any future model-based interpreter has to emit the same JSON and pass the same validator.
3. **Plan:** `planning/actionPlanner.ts` simulates the glass state machine (on table → reached → held → placed → released) and where the actor stands. It inserts missing prerequisites, marked `auto` (walk to the glass before reaching, reach before grip, release after place), and rejects transitions it cannot fix, such as releasing a glass that is not held. `sceneConstraints.ts` computes approach points from the table bounds, the reach envelope and the placement spots.
4. **Compose:** `animation/motionComposer.ts` builds the pose as a pure function of time `t`. Scrubbing and seeking are therefore exact, and playback is reproducible:
   - **Base motion:** the library clips `Idle_Loop` and `Walk_Loop`. The walk phase is driven by the distance travelled, so the feet match the root speed. Horizontal root motion goes on the `root` bone.
   - **Procedural layers:** spine bend, head/neck gaze (look-at), and analytic two-bone IK for the arms using the rig's own bone lengths. The upper-body bend needed to reach a target is solved automatically.
   - **Glass:** attached to the palm at the end of `grip` with the relative offset kept. It follows the hand while held, settles exactly on the placement point, and stays there after `release`.
5. **Retime:** `timeline/retiming.ts` turns a duration request into explicit `duration` values on the affected actions (stored in the project, shown on the timeline, undoable, baked into exports). For a group it finds one common stretch factor, clamped per action to plausible limits (e.g. a grip can be at most 4× slower; pauses absorb what is left). A longer walk first slows the gait down to about 0.38 m/s with shorter strides, so the cycle stays tied to the distance travelled; any remaining time becomes an anticipation phase before setting off (idle breathing, gaze towards the destination), not a frozen pose. Attach/release events and the glass follow automatically because they are derived from the composed action times.
6. **Bake:** `animation/animationBaker.ts` samples the performance at 30 fps into MotionRecorder tracks, plus a separate glass track for the scene export.

**Sitting:** the scene has a chair (`#chair`). “Sit down” / “take a seat” / „setz dich hin“ plays `Sitting_Enter`, then `Sitting_Idle_Loop` while seated, and “stand up” plays `Sitting_Exit`. The planner walks the actor to the chair first, refuses to sit while holding the glass, and inserts a short seated pause plus `stand_up` before the next walk or interaction. While seated the actor can still look, pause and bend.

**Walking back:** “walk back”, “go back”, „geh zurück“ return to the start mark; “walk backwards” still steps 1.5 m backwards.

### Limitations (Director)
- The interpreter is rule-based. It understands the documented vocabulary and close variants, not arbitrary language. A browser-local LLM (e.g. WebLLM on WebGPU) could be added behind the same validator, but it is **not included**: it could not be verified on this development VM, which has no GPU.
- One actor, one table, one glass. Only the glass can be picked up.
- There is no physics or collision avoidance. Walks are straight lines, and the planner only picks the table side to approach.
- Fingers do not curl around the glass, and turning in place slides the feet slightly.
- `PickUp_Table` and the other library clips are not used yet. Reaching is done with IK and bending.
- Timing phrases follow fixed patterns (numbers as digits or words up to 30, seconds/minutes). Relative words without a number ("a bit slower") use fixed factors (×1.4 / ×1.5). Retiming does not add new gestures; extra time is spread over the existing actions.

## Tests

```bash
npm run check      # lint + typecheck + unit tests + production build
npm run test:e2e   # Playwright (first time: npx playwright install chromium)
```

- **Unit (Vitest, `tests/unit/`)** – retargeting accuracy against synthetic
  landmarks generated from the rig's own clips (limb directions, pelvis axis,
  head, arm twist), occlusion handling, grounding, recorder time base and
  quaternion continuity, playback interpolation, `AnimationClip` targets, JSON
  round trip and every rejection path, GLB validation, re-import and replay on a
  fresh rig.
- **E2E (Playwright, `tests/e2e/`)** – runs the app with `?source=synthetic`:
  start → calibrate → live tracking moves the bones → record → deterministic
  scrubbing → JSON and GLB download → delete → re-import both → replay matches
  the original → reload keeps the takes; invalid / wrong-rig files are rejected.

`npm run generate:synthetic` regenerates `src/tracking/synthetic/sequence.json`.

### What still needs a human

Automated tests cannot judge tracking quality with real people. Please verify
with a real webcam: different body sizes, distance, lighting, partial
occlusion (sitting at a desk → upper body only), fast motions, and that a
recorded take looks the same after export → import in a fresh browser profile
and in Blender.

## Known limitations

- Monocular pose estimation: depth (arms pointing at the camera) and wrist/hand
  rotation are approximate. Fingers are not tracked; hands are only aimed
  from the wrist towards the index/pinky landmarks.
- No horizontal root motion (in-place recording); vertical hips motion only via
  foot grounding.
- The retargeting is specific to this mannequin rig; other rigs are rejected on
  import by design.
- Tracking runs at the camera rate on good hardware; on slow GPUs/CPU fallback
  inference is throttled adaptively (shown as "1/n frames").
- The pose model is downloaded from Google's CDN unless `npm run fetch-model` was
  run.

## License

Code: MIT. Mannequin: Quaternius Universal Animation Library, CC0. See
[`LICENSE`](LICENSE).
