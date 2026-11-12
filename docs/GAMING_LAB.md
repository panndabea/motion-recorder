# Gaming Animation Lab

Route: `/gaming-lab` (link **Gaming Animation Lab** in the MotionRecorder header). Code: `src/gaming-lab/`. Tests: `tests/unit/gamingLab/`, `tests/e2e/gamingLab.spec.ts`.

All experiments use the real Quaternius mannequin (`public/models/mannequin.glb`, `DEF-*` bones) and its own clips. Nothing is pre-rendered: every frame is computed from shared time `t` and the parameters, so play, pause, frame stepping, scrubbing, split-screen and baking all give the same result.

## Architecture

| Part | File |
| --- | --- |
| Deterministic actor (pose buffer, clip sampling, FK, model↔world) | `engine/labActor.ts` |
| Experiment contract (`evaluate(ctx)`, controls, presets, handles, chart) | `engine/experiment.ts` |
| Bake to MotionRecorder `MotionData` (30 fps local quaternions + hips translation) | `engine/bake.ts` |
| Two-bone IK on rig chains (wraps the Director's `solveTwoBone`) | `engine/ik/twoBone.ts` |
| Layers/masks/additive/crossfade | `engine/blending/layers.ts` |
| Gaze distribution, limits, rate-limited follower | `engine/gaze/gaze.ts` |
| Seeded value noise, fBm, damped spring | `engine/procedural/noise.ts` |
| Gait speed measurement, foot-lock simulation | `engine/locomotion/` |
| Hand attachment math | `engine/constraints/attachment.ts` |
| Motion-matching database and search | `engine/motion/motionMatching.ts` |
| Viewport (R3F, split-screen, gizmos, debug), controls, explanations | `components/`, `education/concepts.ts` |

Evaluation order inside an experiment: base clip → root trajectory → layers → procedural → gaze → IK → object constraints → debug → render. Stateful techniques (gaze smoothing, springs, foot locks, motion-matching selection) are re-simulated from `t = 0` at a fixed step and cached per parameter set, so seeking is exact.

## Experiments

1. **Inverse Kinematics** – analytic two-bone IK (law of cosines) on `DEF-upper_arm → DEF-forearm → DEF-hand`, pole vector for the elbow, IK strength, reachable/unreachable targets (clamped, limb straightens), degenerate pole fallback, bone lengths preserved. Debug: chain, reach sphere, error line. No joint-angle limits (documented).
2. **Foot Locking / Foot IK** – contact detection from foot height (planted / transition / swing markers), world-space anchors, leg two-bone IK with the animated foot orientation kept, smooth release blend, early release when the leg would over-stretch. Readout: planted-foot sliding per loop without vs. with locking (e.g. *Root too slow*: ≈1.8 m → ≈0.2 m; *Normal walk*: ≈0.9 m → 0).
3. **Motion Warping** – root-trajectory warp toward a draggable target with position/rotation strength and warp window. `Walk_Loop` has no root motion, so the original trajectory is a documented synthetic straight line at the speed measured from the planted feet.
4. **Animation Layers & Blending** – override, additive (relative to a reference pose) and crossfade on local quaternions with bone masks built from rig subtrees; clip and procedural layers.
5. **Look-at / Gaze** – yaw/pitch relative to the animated head, distributed over torso, neck and head, comfortable limits, smoothing and max speed. The mannequin has no eyes; gaze is head-directed.
6. **Motion Matching** – database of 7 mannequin clips at 15 Hz with features (feet positions/velocities relative to hips, hips height, future trajectory at 0.33/0.66/1.0 s), per-dimension normalisation, weighted cost, deterministic ranking, continuation vs. jump with 0.25 s crossblend. Shows top candidates, costs and a cost-per-clip chart. Off = speed-threshold state machine restarting clips at frame 0.
7. **Procedural Secondary Motion** – seeded value noise/fBm and damped springs: breathing, sway, nervousness, shoulders, head micro-motion, follow-through; bounded amplitudes.
8. **Object Interaction & Constraints** – scripted reach → contact → grip → lift → hold → move → place → release → retract with arm IK; cup attached via `offset = hand⁻¹·object` at grip time, world transform kept at release, constraint strength blend. Off = cup stays on the table.
9. **Animation Retiming** – uniform, eased and phased (anticipation / main / hold / follow-through) time maps with inverse mapping, target durations 3–12 s; walk time-scale vs. gait repetition.

## Export

**Bake** samples the technique-enabled result at 30 fps into MotionRecorder JSON (local rotations for all bones + `DEF-hips` translation, incl. root motion folded into the hips for warping/foot locking/motion matching) or GLB, or saves it as a MotionRecorder recording. This is *baked skeletal animation*. Not exported: live interaction (dragging targets), debug overlays, and props — the cup in experiment 8 is scene state, not part of the skeletal file. `meta.source` is `director` because the MotionRecorder format has no dedicated lab value.

## Known limitations

- IK: no joint-angle limits or twist distribution; fingers do not close around objects.
- Foot locking: flat ground (y = 0), no pelvis lowering; when the root moves faster than the steps the leg runs out of reach and the lock lets go, so sliding is only partly reduced (shown by the *Incorrect root speed* and *Root far too fast* presets). Stride warping exists in the engine but is disabled because simple horizontal scaling over-stretches the legs.
- Motion warping: synthetic root path; feet slide when the implied speed ≠ 100 %.
- Motion matching: the mannequin library only has forward locomotion and idles (no turns, strafes, starts, stops), so trajectories differ only in speed and turning is procedural root rotation. Clip speeds are measured from planted feet; `Sprint_Loop` measures slower (≈2.6 m/s) than `Jog_Fwd_Loop` (≈5.3 m/s) because its short toe contact is only partly detected — the database uses the measured values as-is. Brute-force search; cross-blend instead of inertialisation.
- Gaze: head-directed only (no eyes).
- Performance: stateful experiments re-simulate once per parameter change (a few ms–~100 ms on this VM); evaluation itself is per-frame.

## Reuse for the AI Director

The engine modules have no UI dependencies: `solveLimb`, `blendLayer`/`boneMask`, `applyGaze`/`simulateFollower`, `secondaryAngles`, `timeMap`, `warpedRoot`, `simulateFootLock`, `attachmentOffset` and `rankCandidates` take a `LabActor` or plain data and can be called by a Director composer step (e.g. warp a walk to a chair, lock feet after retiming, phased retiming for "hesitate before placing it").
