export interface Concept {
  what: string;
  why: string;
  how: string;
  tryThis: string[];
  disabled: string;
  director: string;
  challenge: string;
  advanced: string;
  /** Shown when the split-screen comparison is not the best visualisation. */
  comparisonNote?: string;
}

export const CONCEPTS: Record<string, Concept> = {
  'inverse-kinematics': {
    what: 'Forward kinematics (FK) asks: "if I rotate the shoulder and elbow like this, where does the hand end up?" Inverse kinematics (IK) asks the opposite: "the hand must be here — how do shoulder and elbow have to rotate?"',
    why: 'Animations are authored for one situation. When a cup, door handle or ledge is somewhere else, the hand would miss it. IK bends the arm at runtime so the hand meets the target, without authoring a new clip.',
    how: 'The mannequin arm is a two-bone chain: upper arm (DEF-upper_arm) and forearm (DEF-forearm) ending at the hand. With bone lengths a and b and target distance d, the law of cosines gives the elbow angle: cos(α) = (a² + d² − b²) / (2ad). The elbow lies in the plane spanned by the target direction and the pole vector. Each bone is then rotated by the shortest arc onto its new direction and converted back to local space with parent⁻¹ · world.',
    tryThis: [
      'Drag the red target above the head (or use the "Reach above head" preset) and watch the elbow swing up.',
      'Switch the elbow pole direction: the hand stays on the target, only the elbow moves around the shoulder–hand axis.',
      'Move the target outside the yellow reach circles: the arm straightens and the error line appears.',
    ],
    disabled: 'With IK off the arm just plays the idle clip — the hand ignores the target and the error distance grows to tens of centimetres.',
    director: 'An AI Director could say "reach for the glass": IK places the hand on the glass even after the table was moved, so the same instruction works in any scene layout.',
    challenge: 'Can you make the character touch the cube on the floor? (Hint: it is out of reach while standing — the error readout tells you how far.)',
    advanced: 'Solver: analytic two-bone (closed form, no iteration, O(1)). Distance is clamped to [|a−b|+ε, 0.9995(a+b)] to avoid the straight-arm singularity; if the pole is parallel to the target direction a fallback pole is used. Bone lengths come from the rig rest translations, so they are preserved exactly. Strength slerps local quaternions between FK and IK. Joint limits are not enforced beyond the pole choice — a production solver adds twist/swing limits per joint.',
  },
  gaze: {
    what: 'A look-at controller turns the head (and, if needed, neck and upper torso) so the character faces a point of interest, on top of whatever animation is playing.',
    why: 'Characters that look at the player, at an object they are about to grab, or at a sound feel alive. Authoring a clip for every possible gaze direction is impossible, so games compute it at runtime.',
    how: 'The target is transformed into the mannequin\'s model space (+Z forward, +Y up). From the head position we get yaw = atan2(dx, dz) and pitch = atan2(dy, √(dx²+dz²)). Both are clamped to comfortable limits, then smoothed by a rate-limited exponential follower. The final angles are distributed over DEF-spine.002/003 (torso), DEF-neck and DEF-head by their weights; each joint gets Ry(yaw·w)·Rx(−pitch·w) pre-multiplied onto its model-space rotation and converted back to local space.',
    tryThis: [
      'Pick "behind left": the head stops at the horizontal limit — raise the torso contribution and the upper body turns further.',
      'Use "Track moving target" and change smoothing / rotation speed: low values snap, high values lag behind like a lazy glance.',
      'Set head strength to 1 and neck/torso to 0: the whole turn happens in one joint and looks like an owl.',
    ],
    disabled: 'Without gaze the head just follows the idle/walk clip and the gaze ray (purple) misses the target; the readout shows the angle error.',
    director: '"Look nervously at the door, then at the glass" becomes a sequence of gaze targets layered on any base motion — no new clip needed, and the look follows the objects wherever they are placed.',
    challenge: 'Can you make the character look at the coin on the floor while walking, without the torso bending more than the head?',
    advanced: 'Eyes: the mannequin has no eye bones, so gaze is head-directed only. The follower is re-simulated from t = 0 at 30 Hz each frame, making it deterministic under scrubbing and baking (cost grows linearly with time; fine for short demo loops, a game would keep state). Splitting yaw/pitch across joints approximates a swing distribution; it avoids twist because each delta is a pure yaw about model Y followed by pitch about model X. Limits are applied to the total, the torso share widens the yaw range.',
  },
  'animation-layers': {
    what: 'Animation layering lets several animations drive different parts of one skeleton at the same time — for example the legs walk while the arm waves.',
    why: 'Combining "walk" with "wave", "carry", "aim" or "look" would otherwise need a separate clip for every combination. Layers with bone masks multiply a small library into many behaviours.',
    how: 'Every bone has a local rotation per clip. A bone mask selects which bones a layer may touch (computed from bone subtrees, e.g. everything under DEF-shoulder.R). Override blending: q = slerp(q_base, q_layer, w). Additive blending stores only the layer\'s change from its reference pose, Δ = q_ref⁻¹·q_layer, and applies it on top: q = q_base·slerp(I, Δ, w). A crossfade is a full-body override whose weight ramps 0→1 over the crossfade duration (smoothstep).',
    tryThis: [
      '"Walk + Wave": switch mode between override and additive — override replaces the walk arm swing, additive adds the wave on top of it.',
      'Turn off all masks: the layer now overrides the whole body and the legs stop walking.',
      '"Crossfade Walk → Jog": set the crossfade to 0 s for a pop, 1.5 s for a smooth transition.',
    ],
    disabled: 'Only the base clip plays — the secondary motion is gone.',
    director: '"Walk to the table while waving" becomes base = walk, layer = wave on the right-arm mask. The Director can stack attitude layers (nervous, tired) on any action.',
    challenge: 'Can you make the character jog while holding the torch up, without the torch arm swinging?',
    advanced: 'Procedural layers are model-space pose modifiers authored on top of Idle_Loop (their reference pose), so override uses the full modified pose while additive uses only the modification. Clip layers use their first frame as reference. All blending is done on local quaternions (slerp keeps them unit length); hips translation always comes from the base (or is lerped during crossfade). Three.js AnimationMixer supports weights and additive clips, but its track filtering by mask requires cloning clips — doing it on sampled poses keeps the lab deterministic and bakeable.',
  },
  'motion-warping': {
    what: 'Motion warping bends a pre-made movement so that it ends exactly where the game needs it — at a door, a ledge or an enemy — while keeping the movement recognisable.',
    why: 'A vault, step or walk-up animation is recorded for one fixed distance and direction. In a game the target is never exactly there. Warping removes the gap without authoring hundreds of variants.',
    how: 'The original root trajectory p₀(t) ends at p₀(T). Inside the warp window [t₀, t₁] we add a smoothly growing correction: p(t) = p₀(t) + w(t)·s·(target − p₀(T)) with w = smoothstep((t − t₀)/(t₁ − t₀)). The heading follows the warped path tangent and, near the end of the window, blends towards the target orientation. This is root/trajectory warping — the joints are untouched; joint-level corrections are IK (experiment 1) and foot locking (experiment 2).',
    tryThis: [
      'Drag the red target around: the orange path bends so the character still arrives on the marker.',
      'Choose "Late warp (end only)": the first part is the original straight walk and the correction is squeezed into the last 30 % — watch the readout\'s implied speed change.',
      'Set the rotation warp strength to 0: the actor arrives at the target but keeps facing along its path.',
    ],
    disabled: 'Without warping the actor walks its original straight line and stops ≈2.8 m ahead regardless of the target; the end-position error shows how far it misses.',
    director: '"Walk to the chair and sit" — the Director can take one walk-and-sit performance and warp it to wherever the chair stands in the current scene.',
    challenge: 'Can you place the target so the actor turns 90° and the implied speed stays below 110 %?',
    advanced: 'Limitation: mannequin.glb\'s Walk_Loop is in place (no root motion; only Roll_RM and Sword_Attack_RM carry root motion). The original trajectory is therefore synthesised: a straight line at the walk speed measured from the planted feet (≈ speed while a foot is at its lowest). Warping changes path length, so the feet slide when the implied speed ≠ 100 %; production systems combine warping with stride scaling and foot IK. Unreal\'s Motion Warping uses similar skew/scale warps of root-motion deltas inside notify windows.',
  },
  'secondary-motion': {
    what: 'Secondary motion is the small, continuous movement layered on top of a main animation — breathing, swaying, fidgeting, little head turns, parts that lag behind and settle.',
    why: 'A perfectly still pose reads as dead or "T-posed". Animators cannot hand-key infinite idle variation, so games add procedural noise and springs that never repeat exactly.',
    how: 'Every effect is a deterministic function of time and a seed: breathing is a sine wave on the upper spine, sway and fidgets use smooth value noise (hashed random values interpolated with a quintic curve, so there is no jitter), and follow-through is a damped spring x″ = k(target − x) − c·x′ integrated from t = 0. The angles are applied as additive model-space rotations on hips, spine, clavicles, hands and head.',
    tryThis: [
      'Start from the default static pose, then raise breathing, sway and head motion one at a time.',
      'Pick "Nervous" and change the seed: same personality, different but repeatable fidgets.',
      'Use "Swaying with follow-through": the head overshoots after the body sways and then settles.',
    ],
    disabled: 'With secondary motion off the static pose is frozen — the chart is empty and nothing moves.',
    director: '"Wait nervously" can map to the nervous preset on top of any action; because it is seeded, a performance replays identically and can be baked.',
    challenge: 'Can you make the character look calm but alive, with no single motion exceeding 3°?',
    advanced: 'Amplitude bounds are fixed per layer (breathing 4°, sway 4°, fidgets 6°, shoulders 6°, head 8°, follow-through 10°) and covered by tests. Noise is value noise rather than Perlin gradient noise; it is C¹ continuous. The spring is re-integrated from t = 0 at 120 Hz each frame so scrubbing gives the same result (a game would keep state). All modifiers are additive deltas so they compose with any base clip.',
  },
  retiming: {
    what: 'Retiming changes when the poses of an animation happen without changing the poses themselves — the same reach can feel careful, hesitant, or snappy.',
    why: 'Timing carries emotion and weight. Games retime to fit gameplay windows (a reload must finish in 1.2 s) and animators use anticipation, holds and follow-through to sell intent.',
    how: 'A time-warp function s = f(t) maps lab time t ∈ [0, T] to source-clip time s ∈ [0, D]; the clip is then sampled at s with normal quaternion slerp between its keys. Uniform: s = D·t/T. Eased: s = D·ease(t/T). Phased: the first 25 % of the source is stretched over the anticipation time, the middle 50 % is the main action with the chosen easing, the key pose at 75 % is held, and the last 25 % is the follow-through. f is monotonic and continuous, so the motion never jumps backwards.',
    tryThis: [
      'Try target durations of 3, 5, 8 and 12 s with "uniform": everything gets slower like slow-motion.',
      'Switch to "phased" and add a hold: the key pose pauses, which reads as hesitation, not slow-motion.',
      'Compare the two walk presets: time-scale slows the steps themselves; gait repetition keeps the natural cadence and the feet slide because the root moves slower than the steps.',
    ],
    disabled: 'Without retiming the original clip plays once at its authored speed (see the dashed 1× line in the chart).',
    director: '"Do it more slowly / hesitate before placing it" maps directly to target duration, hold and anticipation — this is how the Director\'s duration commands should be executed.',
    challenge: 'Can you make PickUp_Table last 5 s so that it feels hesitant rather than slow-motion?',
    advanced: 'Retiming a whole walk cycle (time-scale) is different from adjusting gait repetition: to cover the same distance in more time a real walker takes more, shorter, slower steps. The lab shows both extremes honestly: slowed cycle (no sliding, slow-motion look) and natural cadence at reduced root speed (foot sliding — fix with stride warping or foot locking, experiment 2). Keyframe markers show where each source key lands in lab time via bisection of the inverse map.',
  },
  'foot-locking': {
    what: 'Foot locking pins a foot to the ground while it is supposed to be standing on it, and uses leg IK to bend the knee so the rest of the body can keep moving.',
    why: 'As soon as an animation is played slower or faster, or the character moves at a different speed than the clip was authored for, the planted feet "ice-skate" over the floor. It is one of the most visible animation bugs in games.',
    how: 'Contact detection: a foot counts as planted while its height is within the threshold of its lowest point in the clip (green), transitioning up to twice the threshold (yellow), otherwise swinging (blue). On entering the planted state the foot\'s world position is stored as an anchor; while planted the leg is solved with two-bone IK (DEF-thigh → DEF-shin → DEF-foot) so the foot stays on the anchor, and the foot keeps its animated orientation. When contact ends — or the leg would over-stretch — the correction blends back to the animation over the release time. Optional stride warping scales the feet\'s horizontal distance from the hips by root speed ÷ animated speed so the steps match the travel speed.',
    tryThis: [
      'Use split-screen with "Normal walk": the clip\'s feet already drift a little; the locked side keeps them still.',
      '"Root too slow": without locking the feet slide backwards; with locking they stay put.',
      '"Slowed walk": the clip is slowed but the root slows down even more, so the feet would slide backwards — locking removes it.',
      '"Incorrect root speed" / "Root far too fast (limit)": when the root moves faster than the steps, a planted foot falls behind until the leg cannot reach any more, so the lock must let go early. Locking only partly helps; stride warping helps a little. That is the physical limit of locking alone.',
    ],
    disabled: 'Without locking, the planted foot (green marker) moves across the floor; the readout shows the total sliding distance per loop.',
    director: 'When the Director retimes a walk ("walk more slowly") or warps it to reach a chair, foot locking keeps the result believable instead of skating.',
    challenge: 'Find the largest root-speed mismatch at which locking still removes most of the sliding.',
    advanced: 'The lock is simulated once per parameter set at 60 Hz over the loop (deterministic, cached) and looked up by time, so scrubbing and baking give identical results. The knee pole points forward (+Z). Limitations: the walk clips are in place, so travel speed is measured from the feet; no pelvis lowering when the leg is stretched; no ground raycast (flat floor at y = 0); toes are not locked separately from the ankle. Production systems combine foot locking with stride warping, speed/cadence matching (choosing a slower clip) and pelvis adjustment.',
  },
  'object-interaction': {
    what: 'Object interaction connects a prop to the character at the right moment: the hand reaches the object, the object is attached to the hand while it is held, and it is released exactly where the hand put it down.',
    why: 'Without a proper constraint a picked-up cup stays on the table while the hand mimes, or it pops into the hand. Games need reliable pick-up, carry and place that work wherever the object stands.',
    how: 'The sequence reach → contact → grip → lift → hold → move → place → release → retract drives an IK target for the right arm. At grip time the object\'s transform relative to the hand is stored: offset = hand⁻¹ · object. While held, object(t) = hand(t) · offset, so it follows every hand motion. At release the current world transform is kept, so nothing jumps. Everything is reconstructed from time and parameters, so seeking to any frame gives the right object state.',
    tryThis: [
      'Toggle "Attachment on" in split-screen: the left cup stays behind on the table while the hand mimes.',
      'Drag the green place target across the table: reach, move and place adapt.',
      'Lower the constraint strength: the cup lags between the hand and the table — a broken constraint.',
    ],
    disabled: 'With attachment off the hand performs the same motion but the cup never leaves the table.',
    director: '"Pick up the glass and put it on the other side of the table" maps to exactly this script; the AI Director already uses the same hand-relative attachment for its glass.',
    challenge: 'Can you place the cup at the far edge of the table without the arm fully stretching?',
    advanced: 'Grip offset: the wrist target is placed 7 cm from the grip point towards the shoulder (palm length) and 2 cm above. Fingers do not close (no finger IK). The constraint blend k lerps position and slerps rotation between the rigid attachment and the table pose. Bakes export the skeleton only; the cup track is scene state, documented as not part of the skeletal export.',
  },
};
