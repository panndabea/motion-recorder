import { useEffect, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Grid, OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { MotionEngine } from '../engine/MotionEngine';

type Preset = 'front' | 'back' | 'side';
const PRESETS: Record<Preset, [number, number, number]> = {
  front: [0, 1.25, 3.4],
  back: [0, 1.25, -3.4],
  side: [3.4, 1.25, 0],
};
const TARGET: [number, number, number] = [0, 0.95, 0];

function EngineDriver({ engine }: { engine: MotionEngine }) {
  useFrame((_, dt) => engine.update(Math.min(dt, 0.1)));
  return null;
}

function CameraRig({ preset, controls }: { preset: Preset; controls: React.RefObject<OrbitControlsImpl | null> }) {
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    camera.position.set(...PRESETS[preset]);
    controls.current?.target.set(...TARGET);
    controls.current?.update();
  }, [preset, camera, controls]);
  return null;
}

export function CharacterViewport({ engine }: { engine: MotionEngine }) {
  const [preset, setPreset] = useState<Preset>('front');
  const [axes, setAxes] = useState(false);
  const controls = useRef<OrbitControlsImpl | null>(null);
  return (
    <div className="viewport">
      <div className="panel-header">
        <h2>Character</h2>
        <div className="row">
          {(['front', 'back', 'side'] as Preset[]).map((p) => (
            <button key={p} className={preset === p ? 'active' : ''} onClick={() => setPreset(p)} title={p === 'back' ? 'Matches the mirrored webcam preview' : undefined}>
              {p === 'back' ? 'Behind' : p[0].toUpperCase() + p.slice(1)}
            </button>
          ))}
          <label className="check">
            <input type="checkbox" checked={axes} onChange={(e) => setAxes(e.target.checked)} /> Axes
          </label>
        </div>
      </div>
      <div className="canvas-wrap" data-testid="viewport">
        <Canvas shadows="percentage" camera={{ position: PRESETS.front, fov: 40, near: 0.05, far: 100 }} gl={{ preserveDrawingBuffer: true, antialias: true }}>
          <color attach="background" args={['#14161b']} />
          <hemisphereLight args={['#dfe8ff', '#202428', 0.9]} />
          <directionalLight position={[2.5, 4, 3]} intensity={2.2} castShadow shadow-mapSize={[2048, 2048]} shadow-camera-left={-2} shadow-camera-right={2} shadow-camera-top={2.5} shadow-camera-bottom={-1} />
          <directionalLight position={[-3, 2, -2]} intensity={0.6} />
          <primitive object={engine.rig.scene} />
          <mesh rotation-x={-Math.PI / 2} receiveShadow position={[0, -0.001, 0]}>
            <planeGeometry args={[20, 20]} />
            <shadowMaterial opacity={0.35} />
          </mesh>
          <Grid args={[20, 20]} cellSize={0.25} sectionSize={1} cellColor="#2b313b" sectionColor="#3e4756" fadeDistance={14} infiniteGrid />
          {axes && <axesHelper args={[0.6]} />}
          <OrbitControls ref={controls} target={TARGET} enableDamping makeDefault />
          <CameraRig preset={preset} controls={controls} />
          <EngineDriver engine={engine} />
        </Canvas>
      </div>
    </div>
  );
}
