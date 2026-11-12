import { DEBUG_COLORS, dot } from '../../debug/draw';
import type { Experiment, Params } from '../../engine/experiment';
import { MASK_ROOTS, PROCEDURAL_LAYERS, blendLayer, boneMask, cloneRotations, crossfadeWeight, type BlendMode } from '../../engine/blending/layers';
import type { LabActor } from '../../engine/labActor';

const CLIP_LAYERS = ['Idle_Torch_Loop', 'Spell_Simple_Idle_Loop', 'Pistol_Idle_Loop', 'Idle_Talking_Loop', 'Punch_Jab', 'Interact'];
/** Reference pose procedural modifiers are authored on. */
const PROC_REFERENCE = 'Idle_Loop';
const DURATION = 6;

export function layerMask(actor: LabActor, params: Params): Set<string> | null {
  const roots: string[] = [];
  if (params.maskUpper) roots.push(...MASK_ROOTS.upperBody);
  if (params.maskLeftArm) roots.push(...MASK_ROOTS.leftArm);
  if (params.maskRightArm) roots.push(...MASK_ROOTS.rightArm);
  return roots.length ? boneMask(actor.def, roots) : null;
}

/** Layer pose and its reference pose (for additive) at time t. */
function layerPose(actor: LabActor, name: string, t: number) {
  const proc = PROCEDURAL_LAYERS[name];
  if (proc) {
    actor.sampleClip(PROC_REFERENCE, t);
    const reference = cloneRotations(actor.pose.rotations);
    proc(actor, t);
    return { layer: cloneRotations(actor.pose.rotations), reference };
  }
  actor.sampleClip(name, 0);
  const reference = cloneRotations(actor.pose.rotations);
  actor.sampleClip(name, t);
  return { layer: cloneRotations(actor.pose.rotations), reference };
}

export const animationLayers: Experiment = {
  id: 'animation-layers',
  title: 'Animation Layers & Blending',
  duration: () => DURATION,
  toggleKey: 'enabled',
  defaults: { enabled: true, base: 'Walk_Loop', layer: 'Wave (procedural)', mode: 'override', weight: 1, maskUpper: false, maskLeftArm: false, maskRightArm: true, crossfade: 1, showActive: true },
  controls: [
    { key: 'enabled', label: 'Layer enabled', type: 'toggle' },
    { key: 'base', label: 'Base animation', type: 'select', options: ['Walk_Loop', 'Idle_Loop', 'Jog_Fwd_Loop', 'Crouch_Fwd_Loop'] },
    { key: 'layer', label: 'Secondary animation', type: 'select', options: [...Object.keys(PROCEDURAL_LAYERS), ...CLIP_LAYERS] },
    { key: 'mode', label: 'Blend mode', type: 'select', options: ['override', 'additive', 'crossfade'] },
    { key: 'weight', label: 'Blend weight', type: 'range', min: 0, max: 1, step: 0.01 },
    { key: 'maskUpper', label: 'Upper body mask', type: 'toggle' },
    { key: 'maskLeftArm', label: 'Left arm mask', type: 'toggle' },
    { key: 'maskRightArm', label: 'Right arm mask', type: 'toggle' },
    { key: 'crossfade', label: 'Crossfade duration (s)', type: 'range', min: 0, max: 3, step: 0.05 },
    { key: 'showActive', label: 'Show active bones', type: 'toggle' },
  ],
  presets: [
    { name: 'Walk + Wave', params: { base: 'Walk_Loop', layer: 'Wave (procedural)', mode: 'override', maskUpper: false, maskLeftArm: false, maskRightArm: true, weight: 1 } },
    { name: 'Walk + Look left', params: { base: 'Walk_Loop', layer: 'Look left (procedural)', mode: 'additive', maskUpper: true, maskLeftArm: false, maskRightArm: false, weight: 1 } },
    { name: 'Walk + Bent torso', params: { base: 'Walk_Loop', layer: 'Bent torso (procedural)', mode: 'additive', maskUpper: true, maskLeftArm: false, maskRightArm: false, weight: 1 } },
    { name: 'Idle + Raised arm', params: { base: 'Idle_Loop', layer: 'Raised arm (procedural)', mode: 'override', maskUpper: false, maskLeftArm: true, maskRightArm: false, weight: 1 } },
    { name: 'Walk + Nervous shoulders', params: { base: 'Walk_Loop', layer: 'Nervous shoulders (procedural)', mode: 'additive', maskUpper: true, maskLeftArm: false, maskRightArm: false, weight: 1 } },
    { name: 'Walk + Torch (clip, upper body)', params: { base: 'Walk_Loop', layer: 'Idle_Torch_Loop', mode: 'override', maskUpper: true, maskLeftArm: false, maskRightArm: false, weight: 1 } },
    { name: 'Crossfade Walk → Jog', params: { base: 'Walk_Loop', layer: 'Jog_Fwd_Loop', mode: 'crossfade', crossfade: 1.2 } },
  ],
  evaluate: ({ actor, t, params, enabled, state, debug }) => {
    const base = String(params.base);
    const mode = String(params.mode);
    actor.sampleClip(base, t);
    if (!enabled) {
      state.readout = { 'Active layer': 'none (base only)' };
      return;
    }
    const baseRot = cloneRotations(actor.pose.rotations);
    const baseHips = actor.pose.translations.get('DEF-hips')!.clone();
    let w = Number(params.weight);
    let result;
    let mask: Set<string> | null = null;
    if (mode === 'crossfade') {
      // full-body transition from base to the second clip, starting at 1/3 of the loop
      const start = DURATION / 3;
      w = crossfadeWeight(t, start, Number(params.crossfade));
      const target = PROCEDURAL_LAYERS[String(params.layer)] ? 'Jog_Fwd_Loop' : String(params.layer);
      actor.sampleClip(target, t);
      const targetRot = cloneRotations(actor.pose.rotations);
      const targetHips = actor.pose.translations.get('DEF-hips')!.clone();
      result = blendLayer(baseRot, targetRot, null, w, 'override');
      baseHips.lerp(targetHips, w);
    } else {
      mask = layerMask(actor, params);
      const { layer, reference } = layerPose(actor, String(params.layer), t);
      result = blendLayer(baseRot, layer, mask, w, mode as BlendMode, reference);
    }
    actor.restPose();
    for (const [b, q] of result) actor.rot(b).copy(q);
    actor.pose.translations.get('DEF-hips')!.copy(baseHips);
    state.mask = mask;
    state.readout = {
      'Blend mode': mode,
      'Effective weight': w.toFixed(2),
      'Bones affected': mask ? `${mask.size} of ${actor.def.bones.length}` : `all ${actor.def.bones.length}`,
    };
    if (debug && params.showActive && mode !== 'crossfade') {
      const fk = actor.fk();
      for (const b of actor.def.bones) {
        if (!b.name.startsWith('DEF-') || b.name.includes('f_') || b.name.includes('thumb')) continue;
        const active = !mask || mask.has(b.name);
        dot(debug, actor.modelToWorld(fk.get(b.name)!.position), active ? DEBUG_COLORS.modified : DEBUG_COLORS.original, active ? 0.018 : 0.01);
      }
    }
  },
  readouts: ({ state }) => (state.readout as Record<string, string>) ?? {},
  bakeable: true,
};
