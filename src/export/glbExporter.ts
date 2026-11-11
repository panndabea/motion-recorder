import { Accessor, WebIO, type Animation, type Buffer, type Document, type Node } from '@gltf-transform/core';
import { prune } from '@gltf-transform/functions';
import type { MotionData } from '../recording/motionFormat';
import type { RigDefinition } from '../rig/rigDefinition';

export interface GlbExportOptions {
  /** Write constant rest-pose channels for joints without a recorded track (default true). */
  includeRestTracks?: boolean;
}

/**
 * Produces a GLB with the original mannequin (mesh, skin, materials, node names and hierarchy untouched)
 * and exactly one animation: the recorded motion. Built on the source asset with glTF-Transform rather
 * than re-exporting the three.js scene, so no coordinate or naming conversion can creep in.
 */
export async function exportMotionGlb(
  sourceBytes: ArrayBuffer,
  motion: MotionData,
  rig: RigDefinition,
  options: GlbExportOptions = {},
): Promise<Uint8Array> {
  const io = new WebIO();
  const doc = await io.readBinary(new Uint8Array(sourceBytes));
  buildAnimationDocument(doc, motion, rig, options);
  await doc.transform(prune({ keepAttributes: true, keepLeaves: true, keepIndices: true }));
  return io.writeBinary(doc);
}

export function buildAnimationDocument(doc: Document, motion: MotionData, rig: RigDefinition, options: GlbExportOptions = {}) {
  const root = doc.getRoot();
  for (const anim of root.listAnimations()) {
    for (const channel of anim.listChannels()) channel.dispose();
    for (const sampler of anim.listSamplers()) {
      sampler.getInput()?.dispose();
      sampler.getOutput()?.dispose();
      sampler.dispose();
    }
    anim.dispose();
  }
  const buffer: Buffer = root.listBuffers()[0] ?? doc.createBuffer();
  const nodes = new Map<string, Node>();
  for (const node of root.listNodes()) nodes.set(node.getName(), node);
  for (const bone of rig.bones) {
    if (!nodes.has(bone.name)) throw new Error(`GLB is missing joint node "${bone.name}"`);
  }
  root.getAsset().generator = 'MotionRecorder (glTF-Transform)';

  const anim: Animation = doc.createAnimation(motion.name);
  const inputs = new Map<string, Accessor>();
  const inputFor = (times: number[]) => {
    const key = times.join(',');
    let acc = inputs.get(key);
    if (!acc) {
      acc = doc.createAccessor().setType(Accessor.Type.SCALAR).setArray(new Float32Array(times)).setBuffer(buffer);
      inputs.set(key, acc);
    }
    return acc;
  };
  const addChannel = (node: Node, path: 'rotation' | 'translation', times: number[], values: number[][]) => {
    const output = doc
      .createAccessor()
      .setType(path === 'rotation' ? Accessor.Type.VEC4 : Accessor.Type.VEC3)
      .setArray(new Float32Array(values.flat()))
      .setBuffer(buffer);
    const sampler = doc.createAnimationSampler().setInput(inputFor(times)).setOutput(output).setInterpolation('LINEAR');
    anim.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath(path).setSampler(sampler));
  };

  const covered = new Set<string>();
  for (const track of motion.tracks) {
    const node = nodes.get(track.bone);
    if (!node) throw new Error(`GLB has no node for track bone "${track.bone}"`);
    addChannel(node, track.property, track.times, track.values);
    covered.add(`${track.bone}/${track.property}`);
  }

  if (options.includeRestTracks ?? true) {
    const span = [0, Math.max(motion.duration, 1 / 30)];
    for (const bone of rig.bones) {
      const node = nodes.get(bone.name)!;
      if (!covered.has(`${bone.name}/rotation`)) addChannel(node, 'rotation', span, [bone.rotation, bone.rotation]);
      if (!covered.has(`${bone.name}/translation`)) addChannel(node, 'translation', span, [bone.translation, bone.translation]);
    }
  }
  return anim;
}
