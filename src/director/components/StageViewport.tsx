import { useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Grid, OrbitControls, TransformControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { DoubleSide, type Group } from 'three';
import { applyPose, resetToRest, type MannequinRig } from '../../rig/mannequinLoader';
import { DEFAULT_TABLE_SIZE, TABLE_TOP_THICKNESS, glassSize, rad, type SceneObject } from '../scene/sceneModel';
import { useShallow } from 'zustand/react/shallow';
import { tick, updateCamera, updateObject, useDirector } from '../state/directorStore';

function Table({ obj, onSelect }: { obj: SceneObject; onSelect: () => void }) {
  const [w, h, d] = obj.size ?? DEFAULT_TABLE_SIZE;
  const legH = h - TABLE_TOP_THICKNESS;
  return (
    <group onClick={(e) => (e.stopPropagation(), onSelect())}>
      <mesh position={[0, h - TABLE_TOP_THICKNESS / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[w, TABLE_TOP_THICKNESS, d]} />
        <meshStandardMaterial color="#8c6239" roughness={0.7} />
      </mesh>
      {[-1, 1].flatMap((sx) =>
        [-1, 1].map((sz) => (
          <mesh key={`${sx}${sz}`} position={[sx * (w / 2 - 0.05), legH / 2, sz * (d / 2 - 0.05)]} castShadow>
            <boxGeometry args={[0.05, legH, 0.05]} />
            <meshStandardMaterial color="#6e4b2a" roughness={0.8} />
          </mesh>
        )),
      )}
    </group>
  );
}

function GlassMesh({ size }: { size: [number, number, number] }) {
  const [r, h] = size;
  return (
    <group>
      <mesh position={[0, h / 2, 0]} castShadow>
        <cylinderGeometry args={[r, r * 0.85, h, 24, 1, true]} />
        <meshPhysicalMaterial color="#bfe3ff" transparent opacity={0.45} roughness={0.05} side={DoubleSide} />
      </mesh>
      <mesh position={[0, 0.004, 0]}>
        <cylinderGeometry args={[r * 0.85, r * 0.85, 0.008, 24]} />
        <meshPhysicalMaterial color="#bfe3ff" transparent opacity={0.6} roughness={0.05} />
      </mesh>
    </group>
  );
}

/** Drives actor bones and the glass from the deterministic performance at the store's current time. */
function PerformanceDriver({ rig, glass }: { rig: MannequinRig; glass: React.RefObject<Group | null> }) {
  useFrame((_, dt) => {
    tick(Math.min(dt, 0.1));
    const { perf, time } = useDirector.getState();
    if (!perf) return;
    const f = perf.evaluate(time);
    resetToRest(rig);
    applyPose(rig, f.pose);
    if (glass.current) {
      glass.current.position.set(...f.glass.position);
      glass.current.rotation.set(0, f.glass.yaw, 0);
    }
  });
  return null;
}

function Gizmo({ obj, controls }: { obj: SceneObject; controls: React.RefObject<OrbitControlsImpl | null> }) {
  const target = useRef<Group>(null);
  useEffect(() => {
    target.current?.position.set(...obj.position);
    target.current?.rotation.set(0, rad(obj.rotationY), 0);
  }, [obj]);
  return (
    <>
      <group ref={target} position={obj.position}>
        {obj.kind === 'actor' && (
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
            <ringGeometry args={[0.32, 0.38, 40]} />
            <meshBasicMaterial color="#b28cff" />
          </mesh>
        )}
      </group>
      <TransformControls
        object={target as React.RefObject<Group>}
        mode="translate"
        showY={obj.kind !== 'actor' && obj.kind !== 'glass' && obj.kind !== 'table'}
        size={0.7}
        onMouseDown={() => controls.current && (controls.current.enabled = false)}
        onMouseUp={() => {
          if (controls.current) controls.current.enabled = true;
          const p = target.current?.position;
          if (p) updateObject(obj.id, { position: [p.x, p.y, p.z] });
        }}
      />
    </>
  );
}

export function StageViewport({ rig }: { rig: MannequinRig }) {
  const objects = useDirector((s) => s.project.scene.objects);
  const selected = useDirector((s) => s.selectedObject);
  const camera = useMemo(() => useDirector.getState().project.camera, []);
  const controls = useRef<OrbitControlsImpl | null>(null);
  const glass = useRef<Group>(null);
  const table = objects.find((o) => o.id === 'table')!;
  const glassObj = objects.find((o) => o.id === 'glass')!;
  const light = objects.find((o) => o.kind === 'light');
  const sel = objects.find((o) => o.id === selected && ['actor', 'table', 'glass', 'light'].includes(o.kind));
  const select = (id: string) => useDirector.setState({ selectedObject: id, selectedAction: null });

  const resetCamera = () => {
    const cam = useDirector.getState().project.scene.objects.find((o) => o.kind === 'camera');
    const c = controls.current;
    if (!c || !cam) return;
    c.object.position.set(...cam.position);
    c.target.set(...(cam.target ?? [0, 1, 0]));
    c.update();
  };

  return (
    <div className="ds-canvas" data-testid="director-stage">
      <Canvas shadows="percentage" camera={{ position: camera.position, fov: camera.fov, near: 0.05, far: 100 }} gl={{ preserveDrawingBuffer: true, antialias: true }} onPointerMissed={() => useDirector.setState({ selectedObject: null })}>
        <color attach="background" args={['#14121c']} />
        <hemisphereLight args={['#d8d4ff', '#1c1a24', 0.7]} />
        <directionalLight position={light?.position ?? [3, 6, 2]} intensity={light?.value ?? 2.2} castShadow shadow-mapSize={[1024, 1024]} />
        <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow onClick={(e) => (e.stopPropagation(), select('ground'))}>
          <planeGeometry args={[12, 12]} />
          <meshStandardMaterial color="#25222f" roughness={1} />
        </mesh>
        <Grid args={[12, 12]} cellSize={0.25} sectionSize={1} cellColor="#2e2a3c" sectionColor="#4a4363" fadeDistance={14} position={[0, 0.002, 0]} />
        <group position={table.position} rotation={[0, rad(table.rotationY), 0]}>
          <Table obj={table} onSelect={() => select('table')} />
        </group>
        <group ref={glass} onClick={(e) => (e.stopPropagation(), select('glass'))}>
          <GlassMesh size={glassSize(glassObj)} />
        </group>
        <primitive object={rig.scene} onClick={(e: { stopPropagation: () => void }) => (e.stopPropagation(), select('actor'))} />
        <PerformanceDriver rig={rig} glass={glass} />
        {sel && <Gizmo key={sel.id} obj={sel} controls={controls} />}
        <OrbitControls
          ref={controls}
          target={camera.target}
          enableDamping
          makeDefault
          onEnd={() => {
            const c = controls.current;
            if (c) updateCamera({ position: c.object.position.toArray() as [number, number, number], target: c.target.toArray() as [number, number, number], fov: camera.fov });
          }}
        />
      </Canvas>
      <div className="ds-stage-tools">
        <button className="ds-btn" onClick={resetCamera} data-testid="reset-camera">
          Reset camera
        </button>
      </div>
      <StageStatus />
    </div>
  );
}

function StageStatus() {
  const info = useDirector(
    useShallow((s) => {
      if (!s.perf) return null;
      const f = s.perf.evaluate(s.time);
      const a = s.project.actions.find((x) => x.id === f.activeActionId);
      return { glass: f.glassState, action: a ? a.type.replace('_', ' ') : 'idle' };
    }),
  );
  if (!info) return null;
  return (
    <div className="ds-stage-status" data-testid="stage-status">
      <span>
        action: <b data-testid="active-action">{info.action}</b>
      </span>
      <span>
        glass: <b data-testid="glass-state-live">{info.glass.replace('_', ' ')}</b>
      </span>
    </div>
  );
}
