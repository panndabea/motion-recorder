import { BoxGeometry, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { DEBUG_COLORS, dot, line } from '../../debug/draw';
import type { Experiment } from '../../engine/experiment';
import { LIMBS, solveLimb } from '../../engine/ik/twoBone';

const POLES: Record<string, [number, number, number]> = {
  'down-back': [0.3, -1, -0.6],
  down: [0, -1, 0],
  outward: [1, -0.3, 0],
  'up-out': [1, 0.8, 0],
};

export const inverseKinematics: Experiment = {
  id: 'inverse-kinematics',
  title: 'Inverse Kinematics',
  duration: () => 2.5,
  toggleKey: 'enabled',
  defaults: { enabled: true, arm: 'right', tx: -0.22, ty: 1.12, tz: 0.25, strength: 1, pole: 'down-back', showChain: true, showReach: true, showError: true },
  controls: [
    { key: 'enabled', label: 'IK enabled', type: 'toggle' },
    { key: 'arm', label: 'Arm', type: 'select', options: ['right', 'left'] },
    { key: 'tx', label: 'Target X (m)', type: 'range', min: -1, max: 1, step: 0.01 },
    { key: 'ty', label: 'Target Y (m)', type: 'range', min: 0, max: 2.2, step: 0.01 },
    { key: 'tz', label: 'Target Z (m)', type: 'range', min: -1, max: 1.2, step: 0.01 },
    { key: 'strength', label: 'IK strength', type: 'range', min: 0, max: 1, step: 0.01 },
    { key: 'pole', label: 'Elbow pole direction', type: 'select', options: Object.keys(POLES) },
    { key: 'showChain', label: 'Show bone chain', type: 'toggle' },
    { key: 'showReach', label: 'Show maximum reach', type: 'toggle' },
    { key: 'showError', label: 'Show target error', type: 'toggle' },
  ],
  presets: [
    { name: 'Reach forward', params: { tx: -0.2, ty: 1.15, tz: 0.25 } },
    { name: 'Reach above head', params: { tx: -0.2, ty: 1.8, tz: 0.0 } },
    { name: 'Unreachable target', params: { tx: -0.4, ty: 1.3, tz: 1.15 } },
    { name: 'Cube on the floor', params: { tx: -0.25, ty: 0.12, tz: 0.35 } },
  ],
  handles: [{ id: 'target', keys: ['tx', 'ty', 'tz'], color: DEBUG_COLORS.target }],
  createProps: () => {
    const cube = new Mesh(new BoxGeometry(0.12, 0.12, 0.12), new MeshStandardMaterial({ color: '#c08457' }));
    cube.position.set(-0.25, 0.06, 0.35);
    cube.name = 'ik-cube';
    return [cube];
  },
  evaluate: ({ actor, t, params, enabled, state, debug }) => {
    actor.sampleClip('Idle_Loop', t);
    const side = params.arm === 'left' ? -1 : 1;
    const chain = side > 0 ? LIMBS.armR : LIMBS.armL;
    const targetWorld = new Vector3(Number(params.tx) * side, Number(params.ty), Number(params.tz));
    const target = actor.worldToModel(targetWorld);
    const [px, py, pz] = POLES[String(params.pole)] ?? POLES['down-back'];
    // model +X is the mannequin's left; outward for the right arm is -X
    const pole = new Vector3(px * -side, py, pz);
    let solve;
    if (enabled) solve = solveLimb(actor, chain, target, pole, Number(params.strength));
    const fk = actor.fk();
    const root = fk.get(chain.upper)!.position;
    const mid = fk.get(chain.lower)!.position;
    const end = fk.get(chain.end)!.position;
    const reach = (solve?.reach ?? actor.pose.translations.get(chain.lower)!.length() + actor.pose.translations.get(chain.end)!.length()) * actor.scale;
    const endW = actor.modelToWorld(end);
    const error = endW.distanceTo(targetWorld);
    const rootW = actor.modelToWorld(root);
    state.readout = {
      'Hand → target error': `${(error * 100).toFixed(1)} cm`,
      'Target distance from shoulder': `${(rootW.distanceTo(targetWorld) * 100).toFixed(1)} cm`,
      'Max reach (upper + forearm)': `${(reach * 100).toFixed(1)} cm`,
      Reachable: rootW.distanceTo(targetWorld) <= reach ? 'yes' : 'no – limb straightens toward target',
    };
    state.error = error;
    if (!debug) return;
    dot(debug, targetWorld, DEBUG_COLORS.target, 0.035);
    if (params.showChain) {
      const midW = actor.modelToWorld(mid);
      line(debug, [rootW, midW, endW], DEBUG_COLORS.chain);
      for (const p of [rootW, midW, endW]) dot(debug, p, DEBUG_COLORS.chain, 0.02);
      line(debug, [midW, midW.clone().add(actor.modelToWorld(pole.clone().normalize().multiplyScalar(0.25).add(mid)).sub(midW))], DEBUG_COLORS.pole);
    }
    if (params.showError && error > 0.005) line(debug, [endW, targetWorld], DEBUG_COLORS.target);
    if (params.showReach) {
      const ring: Vector3[] = [];
      for (let i = 0; i <= 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        ring.push(rootW.clone().add(new Vector3(Math.cos(a) * reach, Math.sin(a) * reach, 0)));
      }
      line(debug, ring, DEBUG_COLORS.pole);
      const ring2 = ring.map((p) => new Vector3(rootW.x, p.y, rootW.z + (p.x - rootW.x)));
      line(debug, ring2, DEBUG_COLORS.pole);
    }
  },
  readouts: ({ state }) => (state.readout as Record<string, string>) ?? {},
  bakeable: true,
};
