import { BoxGeometry, CylinderGeometry, Group, Matrix4, Mesh, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import { DEBUG_COLORS, dot, line } from '../../debug/draw';
import type { Experiment, Params } from '../../engine/experiment';
import { attachedWorld, attachmentOffset, decompose } from '../../engine/constraints/attachment';
import { LIMBS, solveLimb } from '../../engine/ik/twoBone';
import { smoothstep } from '../../engine/locomotion/gait';
import type { LabActor } from '../../engine/labActor';

export const TABLE_TOP = 0.74;
const CUP_H = 0.12;
export const CUP_START = new Vector3(-0.32, TABLE_TOP, 0.38);

export type Phase = 'idle' | 'reach' | 'contact' | 'grip' | 'lift' | 'hold' | 'move' | 'place' | 'release' | 'retract' | 'done';

export function phases(params: Params) {
  const reach = 1.2 / Math.max(0.2, Number(params.reachSpeed));
  const list: [Phase, number][] = [
    ['idle', 0.4],
    ['reach', reach],
    ['contact', 0.15],
    ['grip', 0.25],
    ['lift', 0.6],
    ['hold', Number(params.hold)],
    ['move', 1.0],
    ['place', 0.6],
    ['release', 0.3],
    ['retract', reach],
    ['done', 0.6],
  ];
  let t = 0;
  return list.map(([name, d]) => {
    const seg = { name, start: t, end: t + d };
    t += d;
    return seg;
  });
}

export function phaseAt(params: Params, t: number) {
  const ph = phases(params);
  const seg = ph.find((p) => t < p.end) ?? ph[ph.length - 1];
  return { ...seg, u: Math.min(1, Math.max(0, (t - seg.start) / Math.max(1e-6, seg.end - seg.start))) };
}

const target = (params: Params) => new Vector3(Number(params.bx), TABLE_TOP, Number(params.bz));
const gripPoint = (base: Vector3, params: Params) => base.clone().add(new Vector3(0, Number(params.gripHeight), 0));

/** Wrist target for a grip point: offset back toward the shoulder by the palm length. */
function wristFor(actor: LabActor, grip: Vector3) {
  const shoulder = actor.modelToWorld(actor.fk().get(LIMBS.armR.upper)!.position);
  return grip.clone().add(shoulder.sub(grip).setY(0).normalize().multiplyScalar(0.07)).add(new Vector3(0, 0.02, 0));
}

/** Poses the actor at time t (idle + right-arm IK along the interaction script). Returns the hand target. */
function poseAt(actor: LabActor, params: Params, t: number, ikOn: boolean) {
  actor.sampleClip('Idle_Loop', t);
  const animatedHand = actor.modelToWorld(actor.fk().get(LIMBS.armR.end)!.position);
  const ph = phaseAt(params, t);
  const lift = new Vector3(0, 0.15, 0);
  const A = wristFor(actor, gripPoint(CUP_START, params));
  const B = wristFor(actor, gripPoint(target(params), params));
  const e = smoothstep(ph.u);
  let goal: Vector3 | null = null;
  switch (ph.name) {
    case 'reach': goal = animatedHand.clone().lerp(A, e); break;
    case 'contact':
    case 'grip': goal = A; break;
    case 'lift': goal = A.clone().add(lift.clone().multiplyScalar(e)); break;
    case 'hold': goal = A.clone().add(lift); break;
    case 'move': goal = A.clone().add(lift).lerp(B.clone().add(lift), e); break;
    case 'place': goal = B.clone().add(lift.clone().multiplyScalar(1 - e)); break;
    case 'release': goal = B; break;
    case 'retract': goal = B.clone().lerp(animatedHand, e); break;
    default: goal = null;
  }
  if (goal && ikOn) solveLimb(actor, LIMBS.armR, actor.worldToModel(goal), new Vector3(0.6, -1, -0.4), 1);
  return goal;
}

function handWorld(actor: LabActor) {
  return actor.modelMatrix().clone().multiply(actor.fk().get(LIMBS.armR.end)!.matrix);
}

interface InteractionCache {
  offset: Matrix4;
  gripT: number;
  releaseT: number;
  releasedWorld: Matrix4;
}

/** Attachment offset at grip time and the object's world transform at release — reconstructed from params only. */
function interactionCache(actor: LabActor, params: Params, state: Record<string, unknown>): InteractionCache {
  const key = JSON.stringify(params);
  if (state.cacheKey === key) return state.cache as InteractionCache;
  const ph = phases(params);
  const gripT = ph.find((p) => p.name === 'grip')!.start;
  const releaseT = ph.find((p) => p.name === 'release')!.start;
  poseAt(actor, params, gripT, true);
  const cupStart = new Matrix4().makeTranslation(CUP_START.x, CUP_START.y, CUP_START.z);
  const offset = attachmentOffset(handWorld(actor), cupStart);
  poseAt(actor, params, releaseT, true);
  const releasedWorld = attachedWorld(handWorld(actor), offset);
  const cache = { offset, gripT, releaseT, releasedWorld };
  state.cache = cache;
  state.cacheKey = key;
  return cache;
}

/** Cup world transform at t: on the table → attached to the hand (blended by constraint strength) → released in place. */
export function cupWorld(actor: LabActor, params: Params, t: number, attach: boolean, state: Record<string, unknown>) {
  const c = interactionCache(actor, params, state);
  const start = new Matrix4().makeTranslation(CUP_START.x, CUP_START.y, CUP_START.z);
  if (!attach || t < c.gripT) return { m: start, attached: false };
  if (t >= c.releaseT) return { m: c.releasedWorld.clone(), attached: false };
  const rigid = attachedWorld(handWorld(actor), c.offset);
  const k = Number(params.strength);
  const a = decompose(rigid);
  const b = decompose(start);
  const m = new Matrix4().compose(b.position.lerp(a.position, k), b.quaternion.slerp(a.quaternion, k), new Vector3(1, 1, 1));
  return { m, attached: true };
}

export const objectInteraction: Experiment = {
  id: 'object-interaction',
  title: 'Object Interaction & Constraints',
  duration: (p) => phases(p).at(-1)!.end,
  toggleKey: 'attach',
  camera: 'three-quarter',
  defaults: { attach: true, reachSpeed: 1, hold: 0.8, gripHeight: 0.06, bx: -0.05, by0: TABLE_TOP, bz: 0.48, strength: 1, showAttach: true, showContacts: true },
  controls: [
    { key: 'attach', label: 'Attachment on', type: 'toggle' },
    { key: 'gripHeight', label: 'Grip position (height on cup, m)', type: 'range', min: 0.01, max: 0.12, step: 0.005 },
    { key: 'reachSpeed', label: 'Reach speed', type: 'range', min: 0.3, max: 3, step: 0.05 },
    { key: 'hold', label: 'Hold duration (s)', type: 'range', min: 0, max: 3, step: 0.1 },
    { key: 'bx', label: 'Object target X (m)', type: 'range', min: -0.6, max: 0.3, step: 0.01 },
    { key: 'bz', label: 'Object target Z (m)', type: 'range', min: 0.2, max: 0.6, step: 0.01 },
    { key: 'strength', label: 'Constraint strength', type: 'range', min: 0, max: 1, step: 0.01 },
    { key: 'showAttach', label: 'Show attachment transform', type: 'toggle' },
    { key: 'showContacts', label: 'Show contact points', type: 'toggle' },
  ],
  presets: [
    { name: 'Pick and place', params: { bx: -0.05, bz: 0.48, hold: 0.8, strength: 1 } },
    { name: 'Slow careful reach', params: { reachSpeed: 0.5, hold: 2 } },
    { name: 'Weak constraint (slipping)', params: { strength: 0.6 } },
    { name: 'Wrong grip height', params: { gripHeight: 0.12 } },
  ],
  handles: [{ id: 'place-target', keys: ['bx', 'by0', 'bz'], color: DEBUG_COLORS.attach }],
  createProps: () => {
    const table = new Group();
    table.name = 'table';
    const top = new Mesh(new BoxGeometry(0.9, 0.04, 0.5), new MeshStandardMaterial({ color: '#6b4f3a' }));
    top.position.set(-0.2, TABLE_TOP - 0.02, 0.45);
    table.add(top);
    for (const [x, z] of [[-0.6, 0.25], [0.2, 0.25], [-0.6, 0.65], [0.2, 0.65]]) {
      const leg = new Mesh(new BoxGeometry(0.04, TABLE_TOP - 0.04, 0.04), new MeshStandardMaterial({ color: '#4d3829' }));
      leg.position.set(x, (TABLE_TOP - 0.04) / 2, z);
      table.add(leg);
    }
    const cup = new Mesh(new CylinderGeometry(0.035, 0.03, CUP_H, 20), new MeshStandardMaterial({ color: '#7fd1ff', transparent: true, opacity: 0.85 }));
    cup.geometry.translate(0, CUP_H / 2, 0);
    cup.name = 'cup';
    return [table, cup];
  },
  evaluate: ({ actor, t, params, enabled, state, debug, props }) => {
    const ph = phaseAt(params, t);
    const goal = poseAt(actor, params, t, true);
    const cup = cupWorld(actor, params, t, enabled, state);
    poseAt(actor, params, t, true); // cupWorld may have re-posed the actor for its cache
    const mesh = props?.find((o) => o.name === 'cup');
    if (mesh) {
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(cup.m);
      mesh.matrixWorldNeedsUpdate = true;
    }
    const hand = handWorld(actor);
    const handPos = decompose(hand).position;
    const cupPos = decompose(cup.m).position;
    const grip = cupPos.clone().add(new Vector3(0, Number(params.gripHeight), 0));
    const interaction = !enabled ? 'no attachment – cup stays on the table' : cup.attached ? 'held (attached to DEF-hand.R)' : t >= interactionCache(actor, params, state).releaseT ? 'released (world transform kept)' : 'on table';
    state.readout = {
      Phase: ph.name,
      'Object state': interaction,
      'Hand → grip point': `${(handPos.distanceTo(grip) * 100).toFixed(1)} cm`,
      'Cup position': `${cupPos.x.toFixed(2)}, ${cupPos.y.toFixed(2)}, ${cupPos.z.toFixed(2)}`,
    };
    state.cupPos = cupPos;
    state.attached = cup.attached;
    if (!debug) return;
    if (goal) dot(debug, goal, DEBUG_COLORS.target, 0.015);
    if (params.showContacts) {
      dot(debug, grip, DEBUG_COLORS.attach, 0.014);
      dot(debug, target(params).add(new Vector3(0, 0.003, 0)), DEBUG_COLORS.attach, 0.03);
    }
    if (params.showAttach && cup.attached) {
      const q = decompose(hand).quaternion;
      for (const [axis, color] of [[new Vector3(1, 0, 0), '#ff5555'], [new Vector3(0, 1, 0), '#55ff55'], [new Vector3(0, 0, 1), '#5588ff']] as const)
        line(debug, [handPos, handPos.clone().add(axis.clone().applyQuaternion(new Quaternion().copy(q)).multiplyScalar(0.1))], color);
      line(debug, [handPos, cupPos], DEBUG_COLORS.attach);
    }
  },
  readouts: ({ state }) => (state.readout as Record<string, string>) ?? {},
  bakeable: true,
};
