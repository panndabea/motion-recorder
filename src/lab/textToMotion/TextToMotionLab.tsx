import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Vector3 } from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { Grid, OrbitControls } from '@react-three/drei';
import { Link } from 'react-router';
import { loadMannequin, type MannequinRig } from '../../rig/mannequinLoader';
import { BONES, MANNEQUIN_URL } from '../../rig/rigSpec';
import { MotionPlayer } from '../../recording/motionPlayback';
import type { MotionData } from '../../recording/motionFormat';
import { serializeMotion, motionFileName } from '../../export/jsonExporter';
import { exportMotionGlb } from '../../export/glbExporter';
import { parseMotionJson } from '../../import/jsonImporter';
import { importMotionGlb } from '../../import/glbImporter';
import { retargetToMannequin, type RetargetReport } from './retarget';
import { maxPoseDeltaDeg } from './poseDelta';
import { ArdyWebGpuGenerator } from './generators/ardyWebGpu';
import { KimodoHttpGenerator } from './generators/kimodoHttp';
import type { MotionGenerator } from './generators/types';

/** Keeps the orbit target (and camera, by the same offset) on the hips so root motion stays in view. */
function Follow({ rig }: { rig: MannequinRig }) {
  const controls = useThree((st) => st.controls) as OrbitControlsImpl | null;
  const camera = useThree((st) => st.camera);
  const hips = useMemo(() => new Vector3(), []);
  useFrame(() => {
    const bone = rig.bones.get(BONES.hips);
    if (!bone || !controls) return;
    bone.getWorldPosition(hips);
    const dx = hips.x - controls.target.x;
    const dz = hips.z - controls.target.z;
    controls.target.x += dx;
    controls.target.z += dz;
    camera.position.x += dx;
    camera.position.z += dz;
    controls.update();
  });
  return null;
}

interface Roundtrip { json: string; glb: string; ok: boolean }

function Driver({ player }: { player: MotionPlayer }) {
  useFrame((_, dt) => player.update(Math.min(dt, 0.1)));
  return null;
}

function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function TextToMotionLab() {
  const [rig, setRig] = useState<MannequinRig | null>(null);
  const [backend, setBackend] = useState<'ardy' | 'kimodo'>('ardy');
  const [kimodoUrl, setKimodoUrl] = useState('http://localhost:8787');
  const [prompt, setPrompt] = useState('A person walking slowly while crouching forward.');
  const [seconds, setSeconds] = useState(6);
  const [seed, setSeed] = useState(42);
  const [status, setStatus] = useState('Loading mannequin…');
  const [busy, setBusy] = useState(false);
  const [motion, setMotion] = useState<MotionData | null>(null);
  const [report, setReport] = useState<RetargetReport | null>(null);
  const [roundtrip, setRoundtrip] = useState<Roundtrip | null>(null);
  const [time, setTime] = useState(0);
  const [follow, setFollow] = useState(true);
  const player = useMemo(() => (rig ? new MotionPlayer(rig) : null), [rig]);
  const ardy = useRef(new ArdyWebGpuGenerator());

  useEffect(() => {
    loadMannequin(MANNEQUIN_URL).then((r) => { setRig(r); setStatus('Ready. Nothing is generated until you press Generate.'); }, (e) => setStatus(String(e)));
  }, []);
  useEffect(() => {
    const id = setInterval(() => player && setTime(player.time), 100);
    return () => clearInterval(id);
  }, [player]);

  const show = (m: MotionData) => {
    setMotion(m);
    player?.load(m);
    player?.play();
  };

  const generate = async (): Promise<MotionData | null> => {
    if (!rig) return null;
    const gen: MotionGenerator = backend === 'ardy' ? ardy.current : new KimodoHttpGenerator(kimodoUrl);
    setBusy(true);
    setRoundtrip(null);
    setStatus(`Generating with ${gen.label}…`);
    try {
      const out = await gen.generate({ prompt, seconds, seed, onProgress: (stage, c, t) => setStatus(`${gen.label}: ${stage} ${t ? Math.round((100 * c) / t) : 0}%`) });
      const { motion: m, report: r } = retargetToMannequin(out, rig.definition, rig.rawHeight, prompt.slice(0, 60));
      setReport(r);
      show(m);
      const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
      setStatus(`Generated ${out.frameCount} frames @ ${out.fps} fps in ${(out.provenance.latencyMs / 1000).toFixed(1)} s${mem ? ` · JS heap ${(mem.usedJSHeapSize / 2 ** 20).toFixed(0)} MiB` : ''}.`);
      return m;
    } catch (e) {
      setMotion(null);
      player?.unload();
      setStatus(`Generation failed (no fallback motion is substituted): ${e instanceof Error ? e.message : String(e)}`);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const verifyRoundtrip = async (m = motion): Promise<Roundtrip | null> => {
    if (!rig || !m) return null;
    const json = parseMotionJson(serializeMotion(m), rig.definition);
    const glbBytes = await exportMotionGlb(rig.sourceBytes, m, rig.definition);
    const glb = await importMotionGlb(glbBytes.slice().buffer, rig.definition);
    const j = json.ok ? `JSON ✓ max Δ ${maxPoseDeltaDeg(m, json.motion).toFixed(3)}°` : `JSON ✗ ${json.errors.join('; ')}`;
    const g = glb.motions[0] ? `GLB ✓ max Δ ${maxPoseDeltaDeg(m, glb.motions[0]).toFixed(3)}° (${(glbBytes.byteLength / 2 ** 20).toFixed(1)} MiB)` : `GLB ✗ ${glb.errors.join('; ')}`;
    const rt = { json: j, glb: g, ok: json.ok && !!glb.motions[0] };
    setRoundtrip(rt);
    return rt;
  };

  const importFile = async (file: File) => {
    if (!rig) return;
    if (file.name.endsWith('.json')) {
      const r = parseMotionJson(await file.text(), rig.definition);
      if (r.ok) { show(r.motion); setStatus(`Imported ${file.name} (${r.motion.frameCount} frames).`); } else setStatus(`Import failed: ${r.errors.join('; ')}`);
    } else {
      const r = await importMotionGlb(await file.arrayBuffer(), rig.definition);
      if (r.motions[0]) { show(r.motions[0]); setStatus(`Imported ${file.name} (${r.motions[0].frameCount} frames).`); } else setStatus(`Import failed: ${r.errors.join('; ')}`);
    }
  };

  useEffect(() => {
    Object.assign(window, { __t2m: { generate, verifyRoundtrip, motion, report, player } });
  });

  const prov = motion?.meta.generator as Record<string, unknown> | undefined;
  return (
    <div className="t2m-lab" style={{ display: 'grid', gridTemplateColumns: '1fr 380px', height: '100vh' }}>
      <div style={{ position: 'relative' }}>
        <Canvas shadows camera={{ position: [3.6, 1.4, 2.4], fov: 45 }}>
          <hemisphereLight intensity={0.8} />
          <directionalLight position={[3, 5, 4]} intensity={1.6} castShadow />
          <Grid infiniteGrid cellSize={0.5} sectionSize={2} fadeDistance={25} />
          {rig && <primitive object={rig.scene} />}
          {player && <Driver player={player} />}
          {rig && follow && <Follow rig={rig} />}
          <OrbitControls target={[0, 0.9, 0]} makeDefault />
        </Canvas>
      </div>
      <aside style={{ padding: 12, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="row"><h2 style={{ margin: 0 }}>Text-to-Motion lab</h2><Link to="/recorder" style={{ marginLeft: 'auto' }}>Recorder →</Link></div>
        <p className="hint">Experimental. Motion comes only from the selected generative model; failures are reported, never replaced.</p>
        <label>Backend <select data-testid="t2m-backend" value={backend} onChange={(e) => setBackend(e.target.value as 'ardy' | 'kimodo')} disabled={busy}>
          <option value="ardy">ARDY Mini Core40 · browser WebGPU (~684 MiB, cached)</option>
          <option value="kimodo">Kimodo SOMA-RP v1.2 · self-hosted HTTP</option>
        </select></label>
        {backend === 'kimodo' && <label>Backend URL <input value={kimodoUrl} onChange={(e) => setKimodoUrl(e.target.value)} disabled={busy} /></label>}
        <textarea data-testid="t2m-prompt" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={busy} />
        <div className="row">
          <label>Seconds <input type="number" min={2} max={10} step={0.5} value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} disabled={busy} style={{ width: 60 }} /></label>
          <label>Seed <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} disabled={busy} style={{ width: 80 }} /></label>
          <button data-testid="t2m-generate" onClick={() => void generate()} disabled={busy || !rig || !prompt.trim()}>Generate</button>
        </div>
        <div data-testid="t2m-status" className="hint">{status}</div>
        {motion && player && (
          <>
            <div className="row">
              <button onClick={() => (player.playing ? player.pause() : player.play())}>{player.playing ? 'Pause' : 'Play'}</button>
              <input data-testid="t2m-scrub" type="range" min={0} max={motion.duration} step={0.01} value={time} onChange={(e) => { player.pause(); player.seek(Number(e.target.value)); }} style={{ flex: 1 }} />
              <span>{time.toFixed(2)} / {motion.duration.toFixed(2)} s</span>
              <label><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow</label>
            </div>
            <div className="row">
              <button onClick={() => download(motionFileName(motion), serializeMotion(motion), 'application/json')}>Motion JSON</button>
              <button onClick={async () => rig && download(motionFileName(motion).replace(/\.json$/, '.glb'), (await exportMotionGlb(rig.sourceBytes, motion, rig.definition)).slice().buffer, 'model/gltf-binary')}>GLB</button>
              <button data-testid="t2m-roundtrip" onClick={() => void verifyRoundtrip()}>Verify export → reimport</button>
            </div>
            {roundtrip && <div data-testid="t2m-roundtrip-result" className="hint">{roundtrip.json}<br />{roundtrip.glb}</div>}
          </>
        )}
        <label>Import JSON/GLB <input type="file" accept=".json,.glb" onChange={(e) => e.target.files?.[0] && void importFile(e.target.files[0])} /></label>
        {prov && <pre data-testid="t2m-provenance" style={{ fontSize: 11, whiteSpace: 'pre-wrap' }}>{JSON.stringify({ ...prov, retarget: report ?? undefined }, null, 1)}</pre>}
      </aside>
    </div>
  );
}
