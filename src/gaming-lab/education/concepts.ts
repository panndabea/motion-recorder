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
};
