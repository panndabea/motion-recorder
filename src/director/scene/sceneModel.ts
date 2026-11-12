/**
 * Director scene description: plain data, world units are metres, +Y up. The actor faces +Z at yaw 0,
 * its right hand is on the -X side. Everything the animation engine needs is derived from this data,
 * so moving an object simply re-plans the performance.
 */
export type Vec3 = [number, number, number];
export type ObjectKind = 'actor' | 'table' | 'glass' | 'ground' | 'camera' | 'light';

export interface SceneObject {
  id: string;
  kind: ObjectKind;
  name: string;
  position: Vec3;
  /** Rotation about +Y in degrees. */
  rotationY: number;
  /** Kind-specific dimensions (metres). */
  size?: Vec3;
  /** Lights: intensity. Camera: field of view. */
  value?: number;
  /** Camera: orbit target. */
  target?: Vec3;
}

export interface DirectorScene {
  objects: SceneObject[];
  showGrid: boolean;
  shadows: boolean;
}

/** Table size: width (x), height (y), depth (z). */
export const DEFAULT_TABLE_SIZE: Vec3 = [1.2, 0.75, 0.7];
/** Glass: radius, height, unused. */
export const DEFAULT_GLASS_SIZE: Vec3 = [0.035, 0.12, 0];
/** Table top board thickness. */
export const TABLE_TOP_THICKNESS = 0.04;

export function defaultScene(): DirectorScene {
  return {
    showGrid: true,
    shadows: true,
    objects: [
      { id: 'actor', kind: 'actor', name: 'Actor', position: [0.9, 0, -0.4], rotationY: 0 },
      { id: 'table', kind: 'table', name: 'Table', position: [0, 0, 1.6], rotationY: 0, size: [...DEFAULT_TABLE_SIZE] },
      { id: 'glass', kind: 'glass', name: 'Glass', position: [-0.2, DEFAULT_TABLE_SIZE[1], 1.36], rotationY: 0, size: [...DEFAULT_GLASS_SIZE] },
      { id: 'ground', kind: 'ground', name: 'Ground', position: [0, 0, 0], rotationY: 0, size: [12, 0, 12] },
      { id: 'camera', kind: 'camera', name: 'Camera', position: [3.6, 2.3, -2.4], rotationY: 0, value: 40, target: [0.2, 0.85, 0.9] },
      { id: 'key-light', kind: 'light', name: 'Key light', position: [3, 6, 2], rotationY: 0, value: 2.2 },
    ],
  };
}

export function getObject(scene: DirectorScene, id: string): SceneObject | undefined {
  return scene.objects.find((o) => o.id === id);
}

export function requireObject(scene: DirectorScene, id: string): SceneObject {
  const o = getObject(scene, id);
  if (!o) throw new Error(`Scene has no object "${id}"`);
  return o;
}

export const deg = (r: number) => (r * 180) / Math.PI;
export const rad = (d: number) => (d * Math.PI) / 180;

/** Unit forward vector (x, z) for a yaw in radians (yaw 0 faces +Z). */
export function forwardXZ(yaw: number): [number, number] {
  return [Math.sin(yaw), Math.cos(yaw)];
}

export function yawTowards(from: [number, number], to: [number, number]): number {
  return Math.atan2(to[0] - from[0], to[1] - from[1]);
}

/** Wraps an angle to (-pi, pi]. */
export function wrapAngle(a: number): number {
  let r = a % (2 * Math.PI);
  if (r > Math.PI) r -= 2 * Math.PI;
  if (r <= -Math.PI) r += 2 * Math.PI;
  return r;
}

export interface TableFrame {
  center: [number, number];
  half: [number, number];
  yaw: number;
  topY: number;
}

export function tableFrame(table: SceneObject): TableFrame {
  const size = table.size ?? DEFAULT_TABLE_SIZE;
  return { center: [table.position[0], table.position[2]], half: [size[0] / 2, size[2] / 2], yaw: rad(table.rotationY), topY: table.position[1] + size[1] };
}

/** World (x, z) -> table-local (x, z). */
export function toTableLocal(f: TableFrame, p: [number, number]): [number, number] {
  const dx = p[0] - f.center[0];
  const dz = p[1] - f.center[1];
  const c = Math.cos(f.yaw);
  const s = Math.sin(f.yaw);
  return [c * dx - s * dz, s * dx + c * dz];
}

export function fromTableLocal(f: TableFrame, l: [number, number]): [number, number] {
  const c = Math.cos(f.yaw);
  const s = Math.sin(f.yaw);
  return [f.center[0] + c * l[0] + s * l[1], f.center[1] - s * l[0] + c * l[1]];
}

/** True if a world point (x, z) lies over the table top (with an inward margin). */
export function isOverTable(f: TableFrame, p: [number, number], margin = 0): boolean {
  const l = toTableLocal(f, p);
  return Math.abs(l[0]) <= f.half[0] - margin && Math.abs(l[1]) <= f.half[1] - margin;
}

/** True if the glass stands on the table top. */
export function isOnTable(glass: SceneObject, table: SceneObject): boolean {
  const f = tableFrame(table);
  return Math.abs(glass.position[1] - f.topY) < 0.02 && isOverTable(f, [glass.position[0], glass.position[2]]);
}

export function glassSize(glass: SceneObject): Vec3 {
  return glass.size ?? DEFAULT_GLASS_SIZE;
}

/** Validates transforms (finite numbers, sane sizes). Returns error strings. */
export function validateScene(scene: DirectorScene): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const o of scene.objects) {
    if (ids.has(o.id)) errors.push(`Duplicate object id "${o.id}".`);
    ids.add(o.id);
    if (!o.position.every(Number.isFinite) || !Number.isFinite(o.rotationY)) errors.push(`${o.name}: invalid transform.`);
    if (o.size && !o.size.every((v) => Number.isFinite(v) && v >= 0)) errors.push(`${o.name}: invalid size.`);
  }
  for (const req of ['actor', 'table', 'glass']) if (!ids.has(req)) errors.push(`Scene must contain "${req}".`);
  return errors;
}
