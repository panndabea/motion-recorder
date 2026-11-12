import { BufferGeometry, Color, Line, LineBasicMaterial, Mesh, MeshBasicMaterial, SphereGeometry, Vector3, type Object3D } from 'three';
import type { LabActor } from '../engine/labActor';

/** Consistent debug colours across experiments. */
export const DEBUG_COLORS = {
  target: '#ff4d6d',
  chain: '#4dd2ff',
  pole: '#ffd24d',
  planted: '#3ddc84',
  transition: '#ffd24d',
  swing: '#4d8bff',
  original: '#888888',
  modified: '#ff9f1c',
  gaze: '#c77dff',
  attach: '#3ddc84',
} as const;

const sphere = new SphereGeometry(1, 12, 8);
const materials = new Map<string, MeshBasicMaterial>();
const lineMaterials = new Map<string, LineBasicMaterial>();
const mat = (c: string) => materials.get(c) ?? materials.set(c, new MeshBasicMaterial({ color: new Color(c), depthTest: false, transparent: true, opacity: 0.9 })).get(c)!;
const lmat = (c: string) => lineMaterials.get(c) ?? lineMaterials.set(c, new LineBasicMaterial({ color: new Color(c), depthTest: false })).get(c)!;

export function clearDebug(group: Object3D | null) {
  if (!group) return;
  for (const child of [...group.children]) {
    group.remove(child);
    if (child instanceof Line) child.geometry.dispose();
  }
}

export function dot(group: Object3D | null, p: Vector3, color: string, radius = 0.025) {
  if (!group) return;
  const m = new Mesh(sphere, mat(color));
  m.position.copy(p);
  m.scale.setScalar(radius);
  m.renderOrder = 10;
  group.add(m);
}

export function line(group: Object3D | null, points: Vector3[], color: string) {
  if (!group || points.length < 2) return;
  const l = new Line(new BufferGeometry().setFromPoints(points), lmat(color));
  l.renderOrder = 10;
  group.add(l);
}

/** Skeleton lines for the given bones (world space). */
export function skeleton(group: Object3D | null, actor: LabActor, bones?: Set<string>, color: string = DEBUG_COLORS.chain) {
  if (!group) return;
  const fk = actor.fk();
  for (const b of actor.def.bones) {
    if (!b.parent || (bones && !bones.has(b.name))) continue;
    if (!b.name.startsWith('DEF-') || b.name.includes('f_') || b.name.includes('thumb')) continue;
    line(group, [actor.modelToWorld(fk.get(b.parent)!.position), actor.modelToWorld(fk.get(b.name)!.position)], color);
  }
}

export const v3 = (x = 0, y = 0, z = 0) => new Vector3(x, y, z);
