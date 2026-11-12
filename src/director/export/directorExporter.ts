import { Accessor, WebIO, type Buffer, type Document, type Material, type Node } from '@gltf-transform/core';
import { Quaternion, Vector3 } from 'three';
import type { RigDefinition } from '../../rig/rigDefinition';
import type { MotionData } from '../../recording/motionFormat';
import { buildAnimationDocument } from '../../export/glbExporter';
import { importMotionGlb } from '../../import/glbImporter';
import { glassSize, rad, requireObject, TABLE_TOP_THICKNESS, DEFAULT_TABLE_SIZE, type DirectorScene } from '../scene/sceneModel';
import type { ObjectTrack } from '../animation/animationBaker';

interface Geo {
  positions: number[];
  normals: number[];
  indices: number[];
}

function box(sx: number, sy: number, sz: number, cx = 0, cy = 0, cz = 0): Geo {
  const g: Geo = { positions: [], normals: [], indices: [] };
  const faces: [Vector3, Vector3, Vector3][] = [
    [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)],
    [new Vector3(-1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, -1)],
    [new Vector3(0, 1, 0), new Vector3(0, 0, 1), new Vector3(1, 0, 0)],
    [new Vector3(0, -1, 0), new Vector3(0, 0, -1), new Vector3(1, 0, 0)],
    [new Vector3(0, 0, 1), new Vector3(1, 0, 0), new Vector3(0, 1, 0)],
    [new Vector3(0, 0, -1), new Vector3(-1, 0, 0), new Vector3(0, 1, 0)],
  ];
  const h = new Vector3(sx / 2, sy / 2, sz / 2);
  for (const [n, u, v] of faces) {
    const base = g.positions.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = n.clone().add(u.clone().multiplyScalar(a)).add(v.clone().multiplyScalar(b)).multiply(h);
      g.positions.push(p.x + cx, p.y + cy, p.z + cz);
      g.normals.push(n.x, n.y, n.z);
    }
    // winding: counter-clockwise when viewed from the normal side
    const cross = u.clone().cross(v).dot(n) > 0;
    g.indices.push(...(cross ? [base, base + 1, base + 2, base, base + 2, base + 3] : [base, base + 2, base + 1, base, base + 3, base + 2]));
  }
  return g;
}

function merge(...gs: Geo[]): Geo {
  const out: Geo = { positions: [], normals: [], indices: [] };
  for (const g of gs) {
    const off = out.positions.length / 3;
    out.positions.push(...g.positions);
    out.normals.push(...g.normals);
    out.indices.push(...g.indices.map((i) => i + off));
  }
  return out;
}

/** Open-top cylinder with a bottom, origin at the base centre. */
function cup(radius: number, height: number, segments = 24): Geo {
  const g: Geo = { positions: [], normals: [], indices: [] };
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const x = Math.sin(a);
    const z = Math.cos(a);
    g.positions.push(x * radius, 0, z * radius, x * radius, height, z * radius);
    g.normals.push(x, 0, z, x, 0, z);
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    g.indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const c = g.positions.length / 3;
  g.positions.push(0, 0, 0);
  g.normals.push(0, -1, 0);
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    g.positions.push(Math.sin(a) * radius, 0, Math.cos(a) * radius);
    g.normals.push(0, -1, 0);
  }
  for (let i = 0; i < segments; i++) g.indices.push(c, c + 2 + i, c + 1 + i);
  return g;
}

function meshNode(doc: Document, buffer: Buffer, name: string, geo: Geo, material: Material): Node {
  const pos = doc.createAccessor().setType(Accessor.Type.VEC3).setArray(new Float32Array(geo.positions)).setBuffer(buffer);
  const nor = doc.createAccessor().setType(Accessor.Type.VEC3).setArray(new Float32Array(geo.normals)).setBuffer(buffer);
  const idx = doc.createAccessor().setType(Accessor.Type.SCALAR).setArray(new Uint16Array(geo.indices)).setBuffer(buffer);
  const prim = doc.createPrimitive().setAttribute('POSITION', pos).setAttribute('NORMAL', nor).setIndices(idx).setMaterial(material);
  return doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim));
}

const yawQuat = (deg: number): [number, number, number, number] => {
  const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), rad(deg));
  return [q.x, q.y, q.z, q.w];
};

/**
 * Full scene GLB: the mannequin with the baked actor motion (single animation) plus table, glass and ground
 * nodes. The glass transform is baked into the same animation, so attachment/release survive in any viewer.
 */
export async function exportSceneGlb(sourceBytes: ArrayBuffer, motion: MotionData, def: RigDefinition, scene: DirectorScene, glass: ObjectTrack): Promise<Uint8Array> {
  const io = new WebIO();
  const doc = await io.readBinary(new Uint8Array(sourceBytes));
  buildAnimationDocument(doc, motion, def);
  const root = doc.getRoot();
  const buffer = root.listBuffers()[0] ?? doc.createBuffer();
  const gltfScene = root.getDefaultScene() ?? root.listScenes()[0];
  const anim = root.listAnimations()[0];

  const wood = doc.createMaterial('Table').setBaseColorFactor([0.55, 0.38, 0.24, 1]).setRoughnessFactor(0.7);
  const glassMat = doc.createMaterial('Glass').setBaseColorFactor([0.7, 0.85, 1, 0.45]).setAlphaMode('BLEND').setRoughnessFactor(0.05).setDoubleSided(true);
  const floor = doc.createMaterial('Ground').setBaseColorFactor([0.22, 0.23, 0.26, 1]).setRoughnessFactor(1);

  const table = requireObject(scene, 'table');
  const [w, h, d] = table.size ?? DEFAULT_TABLE_SIZE;
  const leg = 0.05;
  const legH = h - TABLE_TOP_THICKNESS;
  const legs = [-1, 1].flatMap((sx) => [-1, 1].map((sz) => box(leg, legH, leg, sx * (w / 2 - leg), legH / 2, sz * (d / 2 - leg))));
  const tableNode = meshNode(doc, buffer, 'table', merge(box(w, TABLE_TOP_THICKNESS, d, 0, h - TABLE_TOP_THICKNESS / 2, 0), ...legs), wood)
    .setTranslation([...table.position])
    .setRotation(yawQuat(table.rotationY));
  const glassObj = requireObject(scene, 'glass');
  const [gr, gh] = glassSize(glassObj);
  const glassNode = meshNode(doc, buffer, 'glass', cup(gr, gh), glassMat);
  glassNode.setTranslation([...glass.positions[0]]).setRotation(yawQuat((glass.yaws[0] * 180) / Math.PI));
  const ground = requireObject(scene, 'ground');
  const [gw, , gd] = ground.size ?? [12, 0, 12];
  const groundNode = meshNode(doc, buffer, 'ground', box(gw, 0.02, gd, 0, -0.01, 0), floor);
  for (const n of [tableNode, glassNode, groundNode]) gltfScene.addChild(n);

  if (anim) {
    const input = doc.createAccessor().setType(Accessor.Type.SCALAR).setArray(new Float32Array(glass.times)).setBuffer(buffer);
    const tOut = doc.createAccessor().setType(Accessor.Type.VEC3).setArray(new Float32Array(glass.positions.flat())).setBuffer(buffer);
    const qs: number[] = [];
    for (const y of glass.yaws) {
      const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), y);
      qs.push(q.x, q.y, q.z, q.w);
    }
    const rOut = doc.createAccessor().setType(Accessor.Type.VEC4).setArray(new Float32Array(qs)).setBuffer(buffer);
    for (const [path, output] of [['translation', tOut], ['rotation', rOut]] as const) {
      const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation('LINEAR');
      anim.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(glassNode).setTargetPath(path).setSampler(sampler));
    }
  }
  return io.writeBinary(doc);
}

export interface SceneGlbCheck {
  ok: boolean;
  errors: string[];
  motion?: MotionData;
}

/** Re-imports a scene GLB: actor motion must load on a fresh rig and the glass track must match the bake. */
export async function verifySceneGlb(bytes: Uint8Array, def: RigDefinition, glass: ObjectTrack): Promise<SceneGlbCheck> {
  const errors: string[] = [];
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const res = await importMotionGlb(ab, def);
  if (res.motions.length !== 1) errors.push(`Expected one actor animation, found ${res.motions.length}. ${res.errors.join(' ')}`);
  const doc = await new WebIO().readBinary(bytes);
  const node = doc.getRoot().listNodes().find((n) => n.getName() === 'glass');
  if (!node) errors.push('Glass node missing.');
  for (const name of ['table', 'ground']) if (!doc.getRoot().listNodes().some((n) => n.getName() === name)) errors.push(`${name} node missing.`);
  const ch = doc.getRoot().listAnimations()[0]?.listChannels().filter((c) => c.getTargetNode() === node) ?? [];
  const tr = ch.find((c) => c.getTargetPath() === 'translation')?.getSampler()?.getOutput()?.getArray();
  if (!tr) errors.push('Glass translation track missing.');
  else {
    const last = glass.positions[glass.positions.length - 1];
    const n = tr.length;
    const dev = Math.hypot(tr[n - 3] - last[0], tr[n - 2] - last[1], tr[n - 1] - last[2]);
    if (dev > 1e-4) errors.push(`Glass end position deviates by ${dev.toFixed(5)} m.`);
  }
  return { ok: errors.length === 0, errors, motion: res.motions[0] };
}
