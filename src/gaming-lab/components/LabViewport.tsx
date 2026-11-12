import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Grid, OrbitControls, TransformControls } from '@react-three/drei';
import { useEffect, useMemo, useRef } from 'react';
import { AxesHelper, Group, Vector3 } from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { clearDebug, skeleton } from '../debug/draw';
import type { Experiment, ExperimentState, Params } from '../engine/experiment';
import type { LabActor } from '../engine/labActor';
import { labClock, useLab, type CameraPreset } from '../state/gamingLabStore';

const PRESETS: Record<CameraPreset, { pos: [number, number, number]; target: [number, number, number] }> = {
  front: { pos: [0, 1.25, 2.9], target: [0, 0.95, 0.2] },
  side: { pos: [2.9, 1.25, 0.3], target: [0, 0.95, 0.3] },
  'three-quarter': { pos: [-1.7, 1.6, 2.3], target: [0, 0.95, 0.25] },
  top: { pos: [0, 5, 0.8], target: [0, 0, 0.6] },
  wide: { pos: [-3.6, 3.6, 5.2], target: [0.3, 0.4, 1.2] },
  'close-up': { pos: [-1.0, 1.6, 1.6], target: [-0.1, 1.2, 0.2] },
};

/** Camera shared between split-screen views: whichever view the user orbits drives the other. */
export const sharedCamera = { pos: new Vector3(...PRESETS['three-quarter'].pos), target: new Vector3(...PRESETS['three-quarter'].target), version: 0 };

/** Readouts of the technique-enabled view, polled by the controls panel. */
export const liveReadouts: { values: Record<string, string> } = { values: {} };

function Driver({ actor, exp, params, enabled, state, debugGroup, props, primary }: {
  actor: LabActor;
  exp: Experiment;
  params: Params;
  enabled: boolean;
  state: ExperimentState;
  debugGroup: Group;
  props: Group;
  primary: boolean;
}) {
  const showDebug = useLab((s) => s.debug);
  const showSkeleton = useLab((s) => s.skeleton);
  useFrame(() => {
    actor.position.set(0, 0, 0);
    actor.heading = 0;
    clearDebug(debugGroup);
    const ctx = { actor, t: labClock.time, params, enabled, state, debug: showDebug ? debugGroup : null, props: props.children };
    exp.evaluate(ctx);
    actor.apply();
    if (showSkeleton) skeleton(debugGroup, actor);
    if (primary && exp.readouts) liveReadouts.values = exp.readouts(ctx);
  });
  return null;
}

function CameraSync({ controls }: { controls: React.RefObject<OrbitControlsImpl | null> }) {
  const { camera } = useThree();
  const seen = useRef(-1);
  const preset = useLab((s) => s.camera);
  const nonce = useLab((s) => s.cameraNonce);
  useEffect(() => {
    const p = PRESETS[preset];
    sharedCamera.pos.set(...p.pos);
    sharedCamera.target.set(...p.target);
    sharedCamera.version++;
  }, [preset, nonce]);
  useFrame(() => {
    const c = controls.current;
    if (!c) return;
    if (seen.current !== sharedCamera.version) {
      camera.position.copy(sharedCamera.pos);
      c.target.copy(sharedCamera.target);
      c.update();
      seen.current = sharedCamera.version;
    }
  });
  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const onChange = () => {
      sharedCamera.pos.copy(camera.position);
      sharedCamera.target.copy(c.target);
      seen.current = ++sharedCamera.version;
    };
    c.addEventListener('change', onChange);
    return () => c.removeEventListener('change', onChange);
  }, [camera, controls]);
  return null;
}

function Handle({ exp, handle, params, controls }: {
  exp: Experiment;
  handle: NonNullable<Experiment['handles']>[number];
  params: Params;
  controls: React.RefObject<OrbitControlsImpl | null>;
}) {
  const ref = useRef<Group>(null);
  const dragging = useRef(false);
  const [kx, ky, kz] = handle.keys;
  useEffect(() => {
    if (!dragging.current) ref.current?.position.set(Number(params[kx]), Number(params[ky]), Number(params[kz]));
  }, [params, kx, ky, kz]);
  return (
    <>
      <group ref={ref} name={`handle-${handle.id}`}>
        <mesh>
          <sphereGeometry args={[0.05, 16, 12]} />
          <meshBasicMaterial color={handle.color} transparent opacity={0.35} />
        </mesh>
      </group>
      <TransformControls
        object={ref as React.RefObject<Group>}
        size={0.6}
        onMouseDown={() => {
          dragging.current = true;
          if (controls.current) controls.current.enabled = false;
        }}
        onMouseUp={() => {
          dragging.current = false;
          if (controls.current) controls.current.enabled = true;
        }}
        onObjectChange={() => {
          const p = ref.current?.position;
          if (!p) return;
          const r = (v: number) => Math.round(v * 100) / 100;
          useLab.getState().setParams(exp.id, { [kx]: r(p.x), [ky]: r(p.y), [kz]: r(p.z) });
        }}
      />
    </>
  );
}

export function ActorView({ actor, exp, params, enabled, label, primary, testId }: {
  actor: LabActor;
  exp: Experiment;
  params: Params;
  enabled: boolean;
  label?: string;
  primary: boolean;
  testId: string;
}) {
  const controls = useRef<OrbitControlsImpl | null>(null);
  const axes = useLab((s) => s.axes);
  const debugGroup = useMemo(() => new Group(), []);
  const propsGroup = useMemo(() => new Group(), []);
  // views are keyed by experiment id, so scratch state is fresh per experiment
  const state = useMemo<ExperimentState>(() => ({}), []);
  useEffect(() => {
    const props = exp.createProps?.(actor) ?? [];
    if (props.length) propsGroup.add(...props);
    return () => {
      for (const p of props) {
        propsGroup.remove(p);
        p.traverse((o) => {
          const m = o as { geometry?: { dispose(): void }; material?: { dispose(): void } };
          m.geometry?.dispose();
          m.material?.dispose();
        });
      }
      clearDebug(debugGroup);
      actor.reset();
    };
  }, [exp, actor, propsGroup, debugGroup]);
  const p = PRESETS['three-quarter'];
  return (
    <div className="gl-view" data-testid={testId}>
      {label && <div className={`gl-view-label ${enabled ? 'on' : 'off'}`}>{label}</div>}
      <Canvas shadows camera={{ position: p.pos, fov: 45, near: 0.05, far: 100 }} gl={{ preserveDrawingBuffer: true, antialias: true }}>
        <color attach="background" args={['#14161c']} />
        <hemisphereLight args={['#dfe8ff', '#30343d', 1.1]} />
        <directionalLight position={[3, 6, 4]} intensity={1.6} castShadow />
        <Grid args={[20, 20]} cellSize={0.25} sectionSize={1} cellColor="#2b3040" sectionColor="#46506a" infiniteGrid fadeDistance={22} />
        {axes && <primitive object={new AxesHelper(0.6)} />}
        <primitive object={actor.root} />
        <primitive object={propsGroup} />
        <primitive object={debugGroup} />
        <Driver actor={actor} exp={exp} params={params} enabled={enabled} state={state} debugGroup={debugGroup} props={propsGroup} primary={primary} />
        {enabled && exp.handles?.filter((h) => !h.when || h.when(params)).map((h) => <Handle key={h.id} exp={exp} handle={h} params={params} controls={controls} />)}
        <OrbitControls ref={controls} makeDefault target={p.target} />
        <CameraSync controls={controls} />
      </Canvas>
    </div>
  );
}
