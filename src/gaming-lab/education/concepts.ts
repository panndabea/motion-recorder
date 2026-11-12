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
};
