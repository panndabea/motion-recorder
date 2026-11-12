import { ConeGeometry, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import { DEBUG_COLORS, dot, line } from '../../debug/draw';
import type { Experiment, Params } from '../../engine/experiment';
import { blendLayer, cloneRotations } from '../../engine/blending/layers';
import { estimateClipSpeed, smoothstep } from '../../engine/locomotion/gait';
import type { LabActor } from '../../engine/labActor';

const WALK_TIME = 3.5;
const SETTLE = 1.2;
const D2R = Math.PI / 180;

/**
 * Original root trajectory: the walk clip is in place (no root motion in mannequin.glb), so the lab
 * synthesises a straight-line root path at the clip's measured natural speed (documented limitation).
 */
export function originalRoot(t: number, speed: number) {
  return new Vector3(0, 0, -1.5 + speed * Math.min(t, WALK_TIME));
}

/** Offset-correction warp: p(t) = p₀(t) + w(t)·s·(target − p₀(T)), w = smoothstep over the warp window. */
export function warpedRoot(t: number, speed: number, params: Params) {
  const p0 = originalRoot(t, speed);
  const end = originalRoot(WALK_TIME, speed);
  const target = new Vector3(Number(params.tx), 0, Number(params.tz));
  const ws = Number(params.warpStart) * WALK_TIME;
  const we = Math.max(ws + 0.05, Number(params.warpEnd) * WALK_TIME);
  const w = smoothstep((Math.min(t, WALK_TIME) - ws) / (we - ws));
  return p0.add(target.sub(end).multiplyScalar(w * Number(params.posStrength)));
}

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Heading follows the path tangent, then blends to the target orientation near the end of the window. */
export function warpedHeading(t: number, speed: number, params: Params) {
  const tc = Math.min(t, WALK_TIME - 1e-3);
  const a = warpedRoot(Math.max(0, tc - 0.05), speed, params);
  const b = warpedRoot(tc + 0.05, speed, params);
  const tangent = Math.atan2(b.x - a.x, b.z - a.z);
  const ws = Number(params.warpStart) * WALK_TIME;
  const we = Math.max(ws + 0.05, Number(params.warpEnd) * WALK_TIME);
  const rotStart = we - 0.4 * (we - ws);
  const w = smoothstep((Math.min(t, WALK_TIME + SETTLE * 0.5) - rotStart) / (we - rotStart + SETTLE * 0.5)) * Number(params.rotStrength);
  const goal = Number(params.yaw) * D2R;
  return tangent + wrapAngle(goal - tangent) * w;
}

function pose(actor: LabActor, t: number) {
  if (t <= WALK_TIME) return actor.sampleClip('Walk_Loop', t);
  // settle into idle with a short crossfade once the root stops
  actor.sampleClip('Walk_Loop', WALK_TIME);
  const walk = cloneRotations(actor.pose.rotations);
  const hipsWalk = actor.pose.translations.get('DEF-hips')!.clone();
  actor.sampleClip('Idle_Loop', t - WALK_TIME);
  const w = smoothstep((t - WALK_TIME) / 0.35);
  const out = blendLayer(walk, actor.pose.rotations, null, w, 'override');
  for (const [b, q] of out) actor.rot(b).copy(q);
  actor.pose.translations.get('DEF-hips')!.lerpVectors(hipsWalk, actor.pose.translations.get('DEF-hips')!, w);
}

export const motionWarping: Experiment = {
  id: 'motion-warping',
  title: 'Motion Warping',
  duration: () => WALK_TIME + SETTLE,
  toggleKey: 'enabled',
  camera: 'wide',
  defaults: { enabled: true, tx: 1.2, ty0: 0, tz: 2.2, yaw: 60, warpStart: 0.15, warpEnd: 1, posStrength: 1, rotStrength: 1, showOriginal: true, showWarped: true },
  controls: [
    { key: 'enabled', label: 'Motion warping on', type: 'toggle' },
    { key: 'tx', label: 'Target X (m)', type: 'range', min: -3, max: 3, step: 0.05 },
    { key: 'tz', label: 'Target Z (m)', type: 'range', min: -1, max: 5, step: 0.05 },
    { key: 'yaw', label: 'Target orientation (°)', type: 'range', min: -180, max: 180, step: 1 },
    { key: 'warpStart', label: 'Warp start (fraction)', type: 'range', min: 0, max: 0.9, step: 0.01 },
    { key: 'warpEnd', label: 'Warp end (fraction)', type: 'range', min: 0.1, max: 1, step: 0.01 },
    { key: 'posStrength', label: 'Position warp strength', type: 'range', min: 0, max: 1, step: 0.01 },
    { key: 'rotStrength', label: 'Rotation warp strength', type: 'range', min: 0, max: 1, step: 0.01 },
    { key: 'showOriginal', label: 'Show original trajectory', type: 'toggle' },
    { key: 'showWarped', label: 'Show warped trajectory', type: 'toggle' },
  ],
  presets: [
    { name: 'Reach nearby target', params: { tx: 0.4, tz: 1.6, yaw: 0 } },
    { name: 'Reach distant target', params: { tx: -0.8, tz: 4.2, yaw: 0 } },
    { name: 'Turn toward target', params: { tx: 1.6, tz: 2.0, yaw: 90 } },
    { name: 'Late warp (end only)', params: { warpStart: 0.7, warpEnd: 1, tx: 1.2, tz: 2.4 } },
  ],
  handles: [{ id: 'warp-target', keys: ['tx', 'ty0', 'tz'], color: DEBUG_COLORS.target }],
  createProps: () => {
    const m = new Mesh(new ConeGeometry(0.12, 0.3, 16), new MeshBasicMaterial({ color: DEBUG_COLORS.target, transparent: true, opacity: 0.7 }));
    m.rotation.x = Math.PI / 2;
    m.name = 'warp-target-arrow';
    return [m];
  },
  evaluate: ({ actor, t, params, enabled, state, debug, props }) => {
    const speed = estimateClipSpeed(actor, 'Walk_Loop');
    pose(actor, t);
    const p = enabled ? warpedRoot(t, speed, params) : originalRoot(t, speed);
    actor.position.copy(p);
    actor.heading = enabled ? warpedHeading(t, speed, params) : 0;
    const target = new Vector3(Number(params.tx), 0, Number(params.tz));
    const arrow = props?.find((o) => o.name === 'warp-target-arrow');
    if (arrow) {
      arrow.position.set(target.x, 0.05, target.z);
      arrow.rotation.set(Math.PI / 2, 0, -Number(params.yaw) * D2R);
    }
    const end = enabled ? warpedRoot(99, speed, params) : originalRoot(99, speed);
    const endHeading = enabled ? warpedHeading(99, speed, params) : 0;
    let len0 = 0;
    let len1 = 0;
    for (let i = 0; i < 70; i++) {
      const a = (i / 70) * WALK_TIME;
      const b = ((i + 1) / 70) * WALK_TIME;
      len0 += originalRoot(b, speed).distanceTo(originalRoot(a, speed));
      len1 += warpedRoot(b, speed, params).distanceTo(warpedRoot(a, speed, params));
    }
    state.endError = end.distanceTo(target);
    state.readout = {
      'End position error': `${(end.distanceTo(target) * 100).toFixed(1)} cm`,
      'End heading error': `${Math.abs(wrapAngle(endHeading - Number(params.yaw) * D2R) / D2R).toFixed(1)}°`,
      'Path length original → warped': `${len0.toFixed(2)} → ${(enabled ? len1 : len0).toFixed(2)} m`,
      'Implied speed change': `${(((enabled ? len1 : len0) / len0) * 100).toFixed(0)}% (feet slide if ≠ 100%)`,
    };
    if (!debug) return;
    const path = (f: (x: number) => Vector3) => Array.from({ length: 50 }, (_, i) => f((i / 49) * WALK_TIME).setY(0.015));
    if (params.showOriginal) line(debug, path((x) => originalRoot(x, speed)), DEBUG_COLORS.original);
    if (enabled && params.showWarped) line(debug, path((x) => warpedRoot(x, speed, params)), DEBUG_COLORS.modified);
    dot(debug, p.clone().setY(0.02), DEBUG_COLORS.modified, 0.03);
  },
  readouts: ({ state }) => (state.readout as Record<string, string>) ?? {},
  bakeable: true,
};
