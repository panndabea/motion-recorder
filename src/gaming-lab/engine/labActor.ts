import { Group, Matrix4, Quaternion, Vector3 } from 'three';
import { ClipSampler } from '../../director/animation/clipSampler';
import { parseMannequin, resetToRest, type MannequinRig } from '../../rig/mannequinLoader';
import { forwardKinematics, type LocalPose, type ModelTransform } from '../../rig/rigDefinition';
import { DRIVEN_BONES, BONES } from '../../rig/rigSpec';

/**
 * One mannequin instance in the lab. The pose is rebuilt every frame from scratch (clip sample + modifiers),
 * so every experiment is a pure function of time and parameters: scrubbing, split-screen and baking agree.
 * Model space = the armature (`Rig`) local space: +Y up, +Z forward, raw rig units (≈1.83 tall).
 */
export class LabActor {
  readonly root = new Group();
  readonly pose: LocalPose = { rotations: new Map(), translations: new Map() };
  /** World transform of the character (root motion), applied to `root`. */
  readonly position = new Vector3();
  heading = 0;
  private readonly samplers = new Map<string, ClipSampler>();
  /** scene (display scale) -> armature, fixed for the asset. */
  private readonly sceneToArmature = new Matrix4();
  private readonly yawQ = new Quaternion();
  private readonly mm = new Matrix4();
  private readonly mmInv = new Matrix4();

  constructor(readonly rig: MannequinRig) {
    this.root.add(rig.scene);
    this.root.updateMatrixWorld(true);
    this.sceneToArmature.copy(this.root.matrixWorld).invert().multiply(rig.armature.matrixWorld);
  }

  static async create(bytes: ArrayBuffer) {
    return new LabActor(await parseMannequin(bytes));
  }

  get def() {
    return this.rig.definition;
  }

  /** Uniform scale from model units to metres. */
  get scale() {
    return this.rig.scale;
  }

  clipNames() {
    return this.rig.clips.map((c) => c.name);
  }

  sampler(name: string) {
    let s = this.samplers.get(name);
    if (!s) {
      const clip = this.rig.clips.find((c) => c.name === name);
      if (!clip) throw new Error(`mannequin.glb has no clip ${name}`);
      s = new ClipSampler(clip, this.def);
      this.samplers.set(name, s);
    }
    return s;
  }

  /** Resets the pose buffer to the rest pose. */
  restPose() {
    for (const b of this.def.bones) {
      (this.pose.rotations.get(b.name) ?? this.pose.rotations.set(b.name, new Quaternion()).get(b.name)!).fromArray(b.rotation);
      (this.pose.translations.get(b.name) ?? this.pose.translations.set(b.name, new Vector3()).get(b.name)!).fromArray(b.translation);
    }
  }

  /** Rest pose, then the clip sampled at t (looping). */
  sampleClip(name: string, t: number) {
    this.restPose();
    this.sampler(name).sample(t, this.pose.rotations, this.pose.translations);
  }

  rot(bone: string) {
    return this.pose.rotations.get(bone)!;
  }

  /** Model-space transforms of the current pose. */
  fk(): Map<string, ModelTransform> {
    return forwardKinematics(this.def, this.pose);
  }

  /** Model space -> lab world (metres). */
  modelToWorld(p: Vector3, out = new Vector3()) {
    return out.copy(p).applyMatrix4(this.modelMatrix());
  }

  worldToModel(p: Vector3, out = new Vector3()) {
    return out.copy(p).applyMatrix4(this.mmInv.copy(this.modelMatrix()).invert());
  }

  /** Model -> world direction (no translation, no scale). */
  modelDirToWorld(d: Vector3, out = new Vector3()) {
    return out.copy(d).transformDirection(this.modelMatrix());
  }

  worldDirToModel(d: Vector3, out = new Vector3()) {
    return out.copy(d).transformDirection(this.mmInv.copy(this.modelMatrix()).invert());
  }

  /** Lab world from model space: root motion (position, heading) · scene-to-armature (incl. display scale). */
  modelMatrix() {
    this.yawQ.setFromAxisAngle(UP, this.heading);
    return this.mm.compose(this.position, this.yawQ, ONE).multiply(this.sceneToArmature);
  }

  /** Writes the pose buffer to the skinned bones and the root transform to the scene graph. */
  apply() {
    for (const [name, q] of this.pose.rotations) this.rig.bones.get(name)?.quaternion.copy(q);
    for (const [name, t] of this.pose.translations) this.rig.bones.get(name)?.position.copy(t);
    this.root.position.copy(this.position);
    this.root.rotation.set(0, this.heading, 0);
    this.root.updateMatrixWorld(true);
  }

  reset() {
    resetToRest(this.rig);
    this.position.set(0, 0, 0);
    this.heading = 0;
    this.restPose();
    this.apply();
  }
}

const UP = new Vector3(0, 1, 0);
const ONE = new Vector3(1, 1, 1);

export const LAB_BONES = BONES;
/** Bones baked by the lab: the recorder's driven set plus clavicles and toes. */
export const LAB_DRIVEN: readonly string[] = [...DRIVEN_BONES, BONES.shoulderL, BONES.shoulderR, BONES.toeL, BONES.toeR];
