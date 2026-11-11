import { Matrix4, Quaternion, Vector3, type Bone, type Object3D } from 'three';

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export interface BoneDef {
  /** Original glTF node name (e.g. `DEF-upper_arm.L`). */
  name: string;
  parent: string | null;
  /** Rest (bind-time node) local transform, glTF conventions: rotation is [x, y, z, w]. */
  translation: Vec3;
  rotation: Quat;
  scale: Vec3;
}

/**
 * Pure description of the mannequin skeleton. Bones are ordered parents-first.
 * "Model space" is the space of the armature's parent node (`Rig`): +Y up, +Z forward, raw asset units.
 */
export interface RigDefinition {
  id: string;
  bones: BoneDef[];
}

export interface LocalPose {
  rotations: Map<string, Quaternion>;
  translations: Map<string, Vector3>;
}

export interface ModelTransform {
  position: Vector3;
  quaternion: Quaternion;
  matrix: Matrix4;
}

export function emptyPose(): LocalPose {
  return { rotations: new Map(), translations: new Map() };
}

export function rigDefinitionFromBones(
  id: string,
  rootBone: Bone,
  nameOf: (object: Object3D) => string,
): RigDefinition {
  const bones: BoneDef[] = [];
  const visit = (bone: Object3D, parent: string | null) => {
    const name = nameOf(bone);
    bones.push({
      name,
      parent,
      translation: bone.position.toArray() as Vec3,
      rotation: bone.quaternion.toArray() as Quat,
      scale: bone.scale.toArray() as Vec3,
    });
    for (const child of bone.children) {
      if ((child as Bone).isBone) visit(child, name);
    }
  };
  visit(rootBone, null);
  return { id, bones };
}

export function boneIndexMap(def: RigDefinition): Map<string, BoneDef> {
  return new Map(def.bones.map((b) => [b.name, b]));
}

/** FNV-1a hash over names and parent links; identifies the skeleton topology. */
export function rigSignature(def: RigDefinition): string {
  let h = 0x811c9dc5;
  const text = def.bones.map((b) => `${b.name}<${b.parent ?? ''}`).join('|');
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const tmpScale = new Vector3();

/** Forward kinematics in model space. Missing pose entries fall back to the rest transform. */
export function forwardKinematics(def: RigDefinition, pose?: LocalPose): Map<string, ModelTransform> {
  const out = new Map<string, ModelTransform>();
  const local = new Matrix4();
  const pos = new Vector3();
  const rot = new Quaternion();
  for (const bone of def.bones) {
    const r = pose?.rotations.get(bone.name);
    const t = pose?.translations.get(bone.name);
    rot.copy(r ?? new Quaternion().fromArray(bone.rotation));
    pos.copy(t ?? new Vector3().fromArray(bone.translation));
    local.compose(pos, rot, tmpScale.fromArray(bone.scale));
    const matrix = new Matrix4();
    const parent = bone.parent ? out.get(bone.parent) : undefined;
    if (parent) matrix.multiplyMatrices(parent.matrix, local);
    else matrix.copy(local);
    const position = new Vector3();
    const quaternion = new Quaternion();
    matrix.decompose(position, quaternion, tmpScale);
    out.set(bone.name, { position, quaternion, matrix });
  }
  return out;
}

export function restLocalRotation(bone: BoneDef): Quaternion {
  return new Quaternion().fromArray(bone.rotation);
}
