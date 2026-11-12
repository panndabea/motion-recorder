import type { Hand } from '../ai/commandSchema';
import {
  forwardXZ,
  fromTableLocal,
  isOverTable,
  requireObject,
  tableFrame,
  toTableLocal,
  yawTowards,
  type DirectorScene,
  type TableFrame,
  type Vec3,
} from '../scene/sceneModel';

/** Distance between the table edge and the actor's root when working at the table. */
export const TABLE_STANDOFF = 0.3;
/** Lateral offset of the shoulder joint from the body centre line. */
export const SHOULDER_OFFSET = 0.17;
/** Max horizontal distance shoulder -> hand target that the arm (+ upper-body bend) can cover. */
export const MAX_REACH = 0.62;
/** Placement margin from the table edge. */
export const PLACE_MARGIN = 0.08;

export interface Stand {
  pos: [number, number];
  yaw: number;
}

/** Unit vector pointing to the actor's right for a yaw (yaw 0 faces +Z, right is -X). */
export function rightXZ(yaw: number): [number, number] {
  return [-Math.cos(yaw), Math.sin(yaw)];
}

export function handSign(hand: Hand): number {
  return hand === 'right' ? 1 : -1;
}

/** World (x, z) of the shoulder of `hand` for an actor stand. */
export function shoulderXZ(stand: Stand, hand: Hand): [number, number] {
  const r = rightXZ(stand.yaw);
  const s = SHOULDER_OFFSET * handSign(hand);
  return [stand.pos[0] + r[0] * s, stand.pos[1] + r[1] * s];
}

/** Whether a world point (x, z) can be reached with `hand` from `stand`. */
export function inReach(stand: Stand, hand: Hand, p: [number, number]): boolean {
  const sh = shoulderXZ(stand, hand);
  const dx = p[0] - sh[0];
  const dz = p[1] - sh[1];
  const f = forwardXZ(stand.yaw);
  const forward = dx * f[0] + dz * f[1];
  return Math.hypot(dx, dz) <= MAX_REACH && forward > 0.1;
}

interface Edge {
  normal: [number, number];
  /** Projection of a point onto the edge (world x, z). */
  point: [number, number];
  /** Distance of the projected point to the edge line. */
  depth: number;
}

function tableEdges(f: TableFrame, p: [number, number], lateralMargin: number): Edge[] {
  const l = toTableLocal(f, p);
  const clamp = (v: number, h: number) => Math.max(-h + lateralMargin, Math.min(h - lateralMargin, v));
  const local: [number, number, number, number, number][] = [
    // [edge local x, edge local z, normal x, normal z, depth]
    [clamp(l[0], f.half[0]), -f.half[1], 0, -1, Math.abs(l[1] + f.half[1])],
    [clamp(l[0], f.half[0]), f.half[1], 0, 1, Math.abs(f.half[1] - l[1])],
    [-f.half[0], clamp(l[1], f.half[1]), -1, 0, Math.abs(l[0] + f.half[0])],
    [f.half[0], clamp(l[1], f.half[1]), 1, 0, Math.abs(f.half[0] - l[0])],
  ];
  return local.map(([ex, ez, nx, nz, depth]) => {
    const point = fromTableLocal(f, [ex, ez]);
    const o = fromTableLocal(f, [0, 0]);
    const n = fromTableLocal(f, [nx, nz]);
    return { point, normal: [n[0] - o[0], n[1] - o[1]], depth };
  });
}

/** Where the actor stands (and which way it faces) to pick the glass up with `hand`. */
export function glassApproach(scene: DirectorScene, glassPos: Vec3, from: [number, number], hand: Hand): Stand {
  const table = requireObject(scene, 'table');
  const f = tableFrame(table);
  const g: [number, number] = [glassPos[0], glassPos[2]];
  const s = SHOULDER_OFFSET * handSign(hand);
  if (isOverTable(f, g) && Math.abs(glassPos[1] - f.topY) < 0.05) {
    let best: { stand: Stand; cost: number } | null = null;
    for (const e of tableEdges(f, g, 0)) {
      const yaw = Math.atan2(-e.normal[0], -e.normal[1]);
      const r = rightXZ(yaw);
      const base: [number, number] = [g[0] + e.normal[0] * (e.depth + TABLE_STANDOFF), g[1] + e.normal[1] * (e.depth + TABLE_STANDOFF)];
      const pos: [number, number] = [base[0] - r[0] * s, base[1] - r[1] * s];
      const cost = e.depth * 4 + Math.hypot(pos[0] - from[0], pos[1] - from[1]) * 0.3;
      if (!best || cost < best.cost) best = { stand: { pos, yaw }, cost };
    }
    return best!.stand;
  }
  const yaw = yawTowards(from, g);
  const dir = forwardXZ(yaw);
  const r = rightXZ(yaw);
  return { pos: [g[0] - dir[0] * 0.38 - r[0] * s, g[1] - dir[1] * 0.38 - r[1] * s], yaw };
}

/** Seat centre lies this far behind the actor's root once seated (from the Sitting_* clips' hip travel). */
export const SIT_ROOT_OFFSET = 0.3;

/** Where the actor stands (facing the same way as the chair) right before sitting down; null without a chair. */
export function chairStand(scene: DirectorScene): Stand | null {
  const chair = scene.objects.find((o) => o.id === 'chair');
  if (!chair) return null;
  const yaw = (chair.rotationY * Math.PI) / 180;
  const f = forwardXZ(yaw);
  return { pos: [chair.position[0] + f[0] * SIT_ROOT_OFFSET, chair.position[2] + f[1] * SIT_ROOT_OFFSET], yaw };
}

/** Where the actor stands to work at the table, approaching from `from`. */
export function tableApproach(scene: DirectorScene, from: [number, number]): Stand {
  const f = tableFrame(requireObject(scene, 'table'));
  const edges = tableEdges(f, from, 0.25);
  let best = edges[0];
  let bestD = Infinity;
  for (const e of edges) {
    const p: [number, number] = [e.point[0] + e.normal[0] * TABLE_STANDOFF, e.point[1] + e.normal[1] * TABLE_STANDOFF];
    const d = Math.hypot(p[0] - from[0], p[1] - from[1]);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return {
    pos: [best.point[0] + best.normal[0] * TABLE_STANDOFF, best.point[1] + best.normal[1] * TABLE_STANDOFF],
    yaw: Math.atan2(-best.normal[0], -best.normal[1]),
  };
}

/**
 * Where a held glass is set down on the table from `stand`. Prefers `preferred` (usually the spot it was
 * picked up from) when reachable, otherwise a spot in front of the hand, clamped to the table top.
 * Returns null if no spot on the table is reachable.
 */
export function placementPoint(scene: DirectorScene, stand: Stand, hand: Hand, preferred?: Vec3): Vec3 | null {
  const f = tableFrame(requireObject(scene, 'table'));
  if (preferred && isOverTable(f, [preferred[0], preferred[2]], PLACE_MARGIN * 0.5) && inReach(stand, hand, [preferred[0], preferred[2]])) {
    return [preferred[0], f.topY, preferred[2]];
  }
  const sh = shoulderXZ(stand, hand);
  const fw = forwardXZ(stand.yaw);
  const candidate: [number, number] = [sh[0] + fw[0] * 0.45, sh[1] + fw[1] * 0.45];
  const l = toTableLocal(f, candidate);
  const hx = f.half[0] - PLACE_MARGIN;
  const hz = f.half[1] - PLACE_MARGIN;
  const clamped = fromTableLocal(f, [Math.max(-hx, Math.min(hx, l[0])), Math.max(-hz, Math.min(hz, l[1]))]);
  if (!inReach(stand, hand, clamped)) return null;
  return [clamped[0], f.topY, clamped[1]];
}
