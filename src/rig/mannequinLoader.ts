import { Box3, type AnimationClip, type Bone, type Group, type Object3D, type SkinnedMesh } from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RIG_ID, TARGET_HEIGHT } from './rigSpec';
import { rigDefinitionFromBones, type LocalPose, type RigDefinition } from './rigDefinition';

export interface MannequinRig {
  /** glTF scene root; carries the display scale. */
  scene: Group;
  /** Parent of the root bone (`Rig`); its local space is the retargeter's model space. */
  armature: Object3D;
  skinnedMeshes: SkinnedMesh[];
  /** Bones keyed by their original glTF node name. */
  bones: Map<string, Bone>;
  /** Original glTF name for any object of the scene (three.js sanitises names). */
  gltfNameOf: (object: Object3D) => string;
  definition: RigDefinition;
  /** Uniform display scale applied to `scene` (raw units -> metres). */
  scale: number;
  /** Raw asset height in rig units. */
  rawHeight: number;
  /** Library clips shipped with the asset (not used for recording). */
  clips: AnimationClip[];
  /** Original GLB bytes, used by the GLB exporter to keep mesh, skin and node names untouched. */
  sourceBytes: ArrayBuffer;
}

function parseGltf(bytes: ArrayBuffer): Promise<GLTF> {
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(bytes.slice(0), '', resolve, (err) => reject(err instanceof Error ? err : new Error(String(err))));
  });
}

export async function parseMannequin(bytes: ArrayBuffer): Promise<MannequinRig> {
  const gltf = await parseGltf(bytes);
  const json = gltf.parser.json as { nodes?: Array<{ name?: string }> };
  const gltfNameOf = (object: Object3D): string => {
    const assoc = gltf.parser.associations.get(object) as { nodes?: number } | undefined;
    const idx = assoc?.nodes;
    return (idx !== undefined ? json.nodes?.[idx]?.name : undefined) ?? object.name;
  };

  const skinnedMeshes: SkinnedMesh[] = [];
  let rootBone: Bone | undefined;
  gltf.scene.traverse((o) => {
    if ((o as SkinnedMesh).isSkinnedMesh) skinnedMeshes.push(o as SkinnedMesh);
    if ((o as Bone).isBone && !(o.parent as Bone | null)?.isBone && !rootBone) rootBone = o as Bone;
  });
  if (!rootBone || !rootBone.parent) throw new Error('mannequin.glb has no skeleton');
  if (skinnedMeshes.length === 0) throw new Error('mannequin.glb has no skinned mesh');

  const bones = new Map<string, Bone>();
  rootBone.traverse((o) => {
    if ((o as Bone).isBone) bones.set(gltfNameOf(o), o as Bone);
  });
  const definition = rigDefinitionFromBones(RIG_ID, rootBone, gltfNameOf);

  const box = new Box3();
  for (const mesh of skinnedMeshes) {
    mesh.geometry.computeBoundingBox();
    box.union(mesh.geometry.boundingBox!);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
  }
  const rawHeight = box.max.y - box.min.y;
  const scale = TARGET_HEIGHT / rawHeight;
  gltf.scene.scale.setScalar(scale);
  gltf.scene.updateMatrixWorld(true);

  return {
    scene: gltf.scene,
    armature: rootBone.parent,
    skinnedMeshes,
    bones,
    gltfNameOf,
    definition,
    scale,
    rawHeight,
    clips: gltf.animations,
    sourceBytes: bytes,
  };
}

export async function fetchMannequinBytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
  return res.arrayBuffer();
}

export async function loadMannequin(url: string): Promise<MannequinRig> {
  return parseMannequin(await fetchMannequinBytes(url));
}

/** Puts every bone back to its rest (bind-time node) transform. */
export function resetToRest(rig: MannequinRig) {
  for (const def of rig.definition.bones) {
    const bone = rig.bones.get(def.name);
    if (!bone) continue;
    bone.position.fromArray(def.translation);
    bone.quaternion.fromArray(def.rotation);
    bone.scale.fromArray(def.scale);
  }
}

export function applyPose(rig: MannequinRig, pose: LocalPose) {
  for (const [name, q] of pose.rotations) rig.bones.get(name)?.quaternion.copy(q);
  for (const [name, t] of pose.translations) rig.bones.get(name)?.position.copy(t);
}

/** Reads the current local transforms of the given bones. */
export function readPose(rig: MannequinRig, names: Iterable<string>, withTranslation: Iterable<string> = []): LocalPose {
  const pose: LocalPose = { rotations: new Map(), translations: new Map() };
  for (const name of names) {
    const bone = rig.bones.get(name);
    if (bone) pose.rotations.set(name, bone.quaternion.clone());
  }
  for (const name of withTranslation) {
    const bone = rig.bones.get(name);
    if (bone) pose.translations.set(name, bone.position.clone());
  }
  return pose;
}
