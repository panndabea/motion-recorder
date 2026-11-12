import { Mesh, MeshStandardMaterial, SphereGeometry, Vector3 } from 'three';
import { DEBUG_COLORS, dot, line } from '../../debug/draw';
import type { Experiment, Params } from '../../engine/experiment';
import { applyGaze, clampAngles, headForward, simulateFollower, yawPitch } from '../../engine/gaze/gaze';
import type { LabActor } from '../../engine/labActor';

const D2R = Math.PI / 180;

/** Fixed floating targets (world metres). */
export const GAZE_TARGETS: Record<string, [number, number, number]> = {
  'front lamp': [0.2, 1.9, 1.6],
  'left cup': [1.2, 0.9, 0.9],
  'right ball': [-1.3, 1.3, 0.6],
  'floor coin': [0.3, 0.05, 0.9],
  'behind left': [0.9, 1.5, -1.4],
};

/** Target position at time t (moving target circles the actor). */
export function gazeTarget(params: Params, t: number): Vector3 {
  const sel = String(params.target);
  if (sel === 'moving') {
    const a = t * 0.9;
    return new Vector3(Math.sin(a) * 1.6, 1.4 + Math.sin(t * 1.7) * 0.4, Math.cos(a) * 1.6 + 0.3);
  }
  if (sel === 'custom') return new Vector3(Number(params.cx), Number(params.cy), Number(params.cz));
  return new Vector3(...(GAZE_TARGETS[sel] ?? GAZE_TARGETS['front lamp']));
}

function chain(params: Params) {
  return [
    { bone: 'DEF-spine.002', weight: Number(params.torso) * 0.5 },
    { bone: 'DEF-spine.003', weight: Number(params.torso) * 0.5 },
    { bone: 'DEF-neck', weight: Number(params.neck) },
    { bone: 'DEF-head', weight: Number(params.head) },
  ];
}

/** Desired yaw/pitch (model space) from the head of the base pose towards the target. */
function desired(actor: LabActor, params: Params, t: number) {
  actor.sampleClip(String(params.base), t);
  const head = actor.fk().get('DEF-head')!.position.clone();
  const dir = actor.worldToModel(gazeTarget(params, t)).sub(head);
  const want = yawPitch(dir);
  // relative to where the animation already points the head, so the clip's own head motion is kept
  const cur = yawPitch(headForward(actor));
  const raw = { yaw: want.yaw - cur.yaw, pitch: want.pitch - cur.pitch };
  // the torso widens the comfortable range: head+neck reach maxH, the torso adds up to 45°
  const torsoShare = Number(params.torso) / Math.max(1e-6, Number(params.torso) + Number(params.neck) + Number(params.head));
  const limits = { maxYaw: Number(params.maxH) * D2R * (1 + torsoShare), maxPitch: Number(params.maxV) * D2R };
  return { raw, clamped: clampAngles(raw.yaw, raw.pitch, limits) };
}

export const gazeController: Experiment = {
  id: 'gaze',
  title: 'Look-at / Gaze Controller',
  duration: (p) => (p.target === 'moving' ? 7 : 5),
  toggleKey: 'enabled',
  defaults: { enabled: true, base: 'Idle_Loop', target: 'left cup', head: 0.5, neck: 0.3, torso: 0.2, speed: 240, maxH: 70, maxV: 40, smoothing: 0.15, showRay: true, cx: 0.8, cy: 1.6, cz: 1 },
  controls: [
    { key: 'enabled', label: 'Gaze enabled', type: 'toggle' },
    { key: 'target', label: 'Target', type: 'select', options: [...Object.keys(GAZE_TARGETS), 'moving', 'custom'] },
    { key: 'base', label: 'Base animation', type: 'select', options: ['Idle_Loop', 'Walk_Loop', 'Idle_Talking_Loop'] },
    { key: 'head', label: 'Head rotation strength', type: 'range', min: 0, max: 1, step: 0.05 },
    { key: 'neck', label: 'Neck rotation strength', type: 'range', min: 0, max: 1, step: 0.05 },
    { key: 'torso', label: 'Torso contribution', type: 'range', min: 0, max: 1, step: 0.05 },
    { key: 'speed', label: 'Rotation speed (°/s)', type: 'range', min: 20, max: 720, step: 10 },
    { key: 'maxH', label: 'Max horizontal angle (°)', type: 'range', min: 10, max: 120, step: 1 },
    { key: 'maxV', label: 'Max vertical angle (°)', type: 'range', min: 5, max: 80, step: 1 },
    { key: 'smoothing', label: 'Gaze smoothing (s)', type: 'range', min: 0, max: 1, step: 0.01 },
    { key: 'showRay', label: 'Show gaze ray', type: 'toggle' },
  ],
  presets: [
    { name: 'Look at object', params: { target: 'left cup', base: 'Idle_Loop' } },
    { name: 'Track moving target', params: { target: 'moving', smoothing: 0.25, speed: 180 } },
    { name: 'Look behind', params: { target: 'behind left', torso: 0.4 } },
    { name: 'Look down at coin', params: { target: 'floor coin' } },
  ],
  handles: [{ id: 'custom-target', keys: ['cx', 'cy', 'cz'], color: DEBUG_COLORS.gaze, when: (p) => p.target === 'custom' }],
  createProps: () =>
    Object.entries(GAZE_TARGETS).map(([name, p], i) => {
      const m = new Mesh(new SphereGeometry(0.07, 20, 14), new MeshStandardMaterial({ color: ['#ffd166', '#06d6a0', '#ef476f', '#f4a261', '#118ab2'][i], emissive: '#222' }));
      m.position.set(...p);
      m.name = `gaze-${name}`;
      return m;
    }),
  evaluate: ({ actor, t, params, enabled, state, debug }) => {
    const target = gazeTarget(params, t);
    let follow = { yaw: 0, pitch: 0 };
    let raw = { yaw: 0, pitch: 0 };
    if (enabled) {
      follow = simulateFollower((time) => desired(actor, params, time).clamped, t, Number(params.smoothing), Number(params.speed), 1 / 30);
      raw = desired(actor, params, t).raw;
    }
    actor.sampleClip(String(params.base), t);
    if (enabled) applyGaze(actor, chain(params), follow.yaw, follow.pitch);
    const fk = actor.fk();
    const head = fk.get('DEF-head')!.position.clone();
    const fwd = headForward(actor);
    const toTarget = actor.worldToModel(target).sub(head).normalize();
    const err = (Math.acos(Math.min(1, Math.max(-1, fwd.dot(toTarget)))) * 180) / Math.PI;
    state.angleError = err;
    state.readout = {
      'Gaze → target angle': `${err.toFixed(1)}°`,
      'Desired yaw / pitch': enabled ? `${((raw.yaw * 180) / Math.PI).toFixed(0)}° / ${((raw.pitch * 180) / Math.PI).toFixed(0)}°` : '–',
      'Applied yaw / pitch': enabled ? `${((follow.yaw * 180) / Math.PI).toFixed(0)}° / ${((follow.pitch * 180) / Math.PI).toFixed(0)}°` : '–',
      Clamped: enabled && (Math.abs(raw.yaw - follow.yaw) > 0.05 || Math.abs(raw.pitch - follow.pitch) > 0.05) ? 'yes (limit or still turning)' : 'no',
    };
    if (!debug) return;
    if (String(params.target) === 'moving' || String(params.target) === 'custom') dot(debug, target, DEBUG_COLORS.gaze, 0.06);
    if (params.showRay) {
      const hw = actor.modelToWorld(head.clone().add(new Vector3(0, 0.12, 0)));
      line(debug, [hw, hw.clone().add(actor.modelDirToWorld(fwd).multiplyScalar(1.6))], DEBUG_COLORS.gaze);
      line(debug, [hw, target], DEBUG_COLORS.original);
    }
  },
  readouts: ({ state }) => (state.readout as Record<string, string>) ?? {},
  bakeable: true,
};
