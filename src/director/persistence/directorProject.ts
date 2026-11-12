import type { DirectorAction } from '../ai/commandSchema';
import { validateCommands } from '../ai/commandSchema';
import { defaultChair, defaultScene, validateScene, type DirectorScene, type SceneObject, type Vec3 } from '../scene/sceneModel';

export const DIRECTOR_FORMAT = 'director-project';
export const DIRECTOR_VERSION = 1;
export const PROJECT_EXTENSION = '.director.json';

export interface ChatEntry {
  id: string;
  role: 'user' | 'director';
  text: string;
  /** Director replies: whether the instruction was applied. */
  ok?: boolean;
  /** Structured commands that were applied (so reopening never needs to re-interpret text). */
  commands?: unknown[];
  /** Action ids the instruction created or changed (context for "it", "the movement"). */
  affected?: string[];
  /** Set when the director asked a clarification question; the next short answer completes this prompt. */
  clarify?: { prompt: string };
}

export interface DirectorProject {
  format: typeof DIRECTOR_FORMAT;
  version: number;
  name: string;
  createdAt: string;
  updatedAt: string;
  rig: { id: string; signature: string };
  scene: DirectorScene;
  actions: DirectorAction[];
  /** Next action id counter (ids stay stable across edits). */
  nextId: number;
  camera: { position: Vec3; target: Vec3; fov: number };
  settings: { loop: boolean; fps: number };
  chat: ChatEntry[];
  /** Names of MotionRecorder takes sent from this project. */
  motionRefs: string[];
}

export function newProject(rig: { id: string; signature: string }, name = 'Untitled scene'): DirectorProject {
  const now = new Date().toISOString();
  const scene = defaultScene();
  const cam = scene.objects.find((o) => o.kind === 'camera')!;
  return {
    format: DIRECTOR_FORMAT,
    version: DIRECTOR_VERSION,
    name,
    createdAt: now,
    updatedAt: now,
    rig,
    scene,
    actions: [],
    nextId: 1,
    camera: { position: [...cam.position], target: [...(cam.target ?? [0, 1, 0])], fov: cam.value ?? 40 },
    settings: { loop: false, fps: 30 },
    chat: [],
    motionRefs: [],
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const vec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
const KINDS = ['actor', 'table', 'glass', 'chair', 'ground', 'camera', 'light'];

export type ProjectValidation = { ok: true; project: DirectorProject; warnings: string[] } | { ok: false; errors: string[] };

/** Validates an untrusted project (parsed JSON). The data is never executed. */
export function validateProject(input: unknown, rig?: { id: string; signature: string }): ProjectValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObj(input)) return { ok: false, errors: ['Not a JSON object.'] };
  if (input.format !== DIRECTOR_FORMAT) return { ok: false, errors: [`Not a Director project (format "${String(input.format)}").`] };
  if (input.version !== DIRECTOR_VERSION) return { ok: false, errors: [`Unsupported Director project version ${String(input.version)} (expected ${DIRECTOR_VERSION}).`] };
  const r = input.rig;
  if (!isObj(r) || typeof r.id !== 'string' || typeof r.signature !== 'string') errors.push('Missing rig information.');
  else if (rig && (r.id !== rig.id || r.signature !== rig.signature)) errors.push(`Project was made for rig "${r.id}" (${r.signature}), the loaded mannequin is "${rig.id}" (${rig.signature}).`);
  const sc = input.scene;
  let scene: DirectorScene | null = null;
  if (!isObj(sc) || !Array.isArray(sc.objects)) errors.push('Missing scene.');
  else {
    const objects: SceneObject[] = [];
    for (const o of sc.objects) {
      if (!isObj(o) || typeof o.id !== 'string' || !KINDS.includes(o.kind as string) || !vec3(o.position) || typeof o.rotationY !== 'number') {
        errors.push('Invalid scene object.');
        continue;
      }
      objects.push({
        id: o.id,
        kind: o.kind as SceneObject['kind'],
        name: typeof o.name === 'string' ? o.name.slice(0, 80) : o.id,
        position: [...o.position],
        rotationY: o.rotationY,
        ...(vec3(o.size) ? { size: [...o.size] as Vec3 } : {}),
        ...(typeof o.value === 'number' && Number.isFinite(o.value) ? { value: o.value } : {}),
        ...(vec3(o.target) ? { target: [...o.target] as Vec3 } : {}),
      });
    }
    // Projects from before the chair existed get the default one (ids stay stable).
    if (!objects.some((o) => o.id === 'chair')) objects.splice(Math.max(0, objects.findIndex((o) => o.kind === 'ground')), 0, defaultChair());
    scene = { objects, showGrid: sc.showGrid !== false, shadows: sc.shadows !== false };
    errors.push(...validateScene(scene));
  }
  let actions: DirectorAction[] = [];
  if (!Array.isArray(input.actions)) errors.push('Missing actions.');
  else if (input.actions.length && scene) {
    const v = validateCommands({ operation: 'create_sequence', actions: input.actions }, { objectIds: scene.objects.map((o) => o.id) });
    if (!v.ok) errors.push(...v.errors);
    else {
      const ids = new Set<string>();
      actions = (input.actions as Record<string, unknown>[]).map((raw, i) => {
        const spec = (v.commands[0] as unknown as { actions: DirectorAction[] }).actions[i];
        let id = typeof raw.id === 'string' && raw.id.length < 40 ? raw.id : `a${i + 1}`;
        if (ids.has(id)) id = `${id}-${i}`;
        ids.add(id);
        return { ...spec, id, speed: spec.speed ?? 1, ...(raw.auto === true ? { auto: true } : {}), ...(typeof raw.origin === 'string' ? { origin: raw.origin } : {}) };
      });
    }
  }
  const cam = input.camera;
  const camera = isObj(cam) && vec3(cam.position) && vec3(cam.target) && typeof cam.fov === 'number' ? { position: cam.position, target: cam.target, fov: cam.fov } : null;
  if (!camera) warnings.push('Camera state missing; using default.');
  if (errors.length || !scene) return { ok: false, errors };
  const base = newProject(rig ?? (r as { id: string; signature: string }));
  const chat = Array.isArray(input.chat)
    ? (input.chat as unknown[]).filter((c): c is ChatEntry => isObj(c) && typeof c.text === 'string' && (c.role === 'user' || c.role === 'director')).slice(-200)
    : [];
  const maxId = actions.reduce((m, a) => Math.max(m, Number(a.id.replace(/\D/g, '')) || 0), 0);
  return {
    ok: true,
    warnings,
    project: {
      ...base,
      name: typeof input.name === 'string' ? input.name.slice(0, 120) : base.name,
      createdAt: typeof input.createdAt === 'string' ? input.createdAt : base.createdAt,
      updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : base.updatedAt,
      scene,
      actions,
      nextId: Math.max(maxId + 1, typeof input.nextId === 'number' && Number.isInteger(input.nextId) ? input.nextId : 1),
      camera: camera ?? base.camera,
      settings: isObj(input.settings) ? { loop: input.settings.loop === true, fps: 30 } : base.settings,
      chat: chat.map((c) => ({ id: String(c.id), role: c.role, text: c.text.slice(0, 2000), ok: c.ok, commands: Array.isArray(c.commands) ? c.commands : undefined })),
      motionRefs: Array.isArray(input.motionRefs) ? input.motionRefs.filter((m): m is string => typeof m === 'string') : [],
    },
  };
}

export function serializeProject(p: DirectorProject): string {
  return JSON.stringify({ ...p, updatedAt: new Date().toISOString() }, null, 1);
}

export function parseProjectText(text: string, rig?: { id: string; signature: string }): ProjectValidation {
  if (text.length > 20_000_000) return { ok: false, errors: ['File too large.'] };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['File is not valid JSON.'] };
  }
  return validateProject(data, rig);
}
