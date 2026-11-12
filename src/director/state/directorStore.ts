import { create } from 'zustand';
import { createStore, get as idbGet, set as idbSet } from 'idb-keyval';
import type { MannequinRig } from '../../rig/mannequinLoader';
import { rigSignature } from '../../rig/rigDefinition';
import { validateMotion, type MotionData } from '../../recording/motionFormat';
import { exportMotionGlb } from '../../export/glbExporter';
import { importMotionGlb } from '../../import/glbImporter';
import { saveRecording } from '../../storage/recordingStore';
import { runPrompt, runPromptWithModel } from '../ai/directorSession';
import { DEFAULT_LLM_SETTINGS, type LlmSettings } from '../ai/llmInterpreter';
import type { DirectorAction } from '../ai/commandSchema';
import { resolveDependencies } from '../planning/actionPlanner';
import { ComposerContext, composePerformance, type Performance } from '../animation/motionComposer';
import { bakeActorMotion, bakeGlass } from '../animation/animationBaker';
import { exportSceneGlb, verifySceneGlb } from '../export/directorExporter';
import { newProject, parseProjectText, serializeProject, PROJECT_EXTENSION, type DirectorProject } from '../persistence/directorProject';
import { UndoHistory } from '../timeline/undoRedo';
import { isOverTable, requireObject, tableFrame, type SceneObject } from '../scene/sceneModel';

export interface Notice {
  id: number;
  kind: 'info' | 'error' | 'success';
  text: string;
}

interface DirectorState {
  status: 'loading' | 'ready' | 'error';
  error?: string;
  project: DirectorProject;
  perf: Performance | null;
  time: number;
  playing: boolean;
  selectedObject: string | null;
  selectedAction: string | null;
  zoom: number;
  busy: string | null;
  notices: Notice[];
  canUndo: boolean;
  canRedo: boolean;
  llm: LlmSettings;
  /** A prompt is waiting for the local model. */
  thinking: boolean;
}

const LLM_KEY = 'director-studio/llm';
function loadLlmSettings(): LlmSettings {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LLM_KEY) : null;
    const v = raw ? (JSON.parse(raw) as Partial<LlmSettings>) : {};
    return {
      enabled: v.enabled === true,
      baseUrl: typeof v.baseUrl === 'string' && v.baseUrl ? v.baseUrl : DEFAULT_LLM_SETTINGS.baseUrl,
      model: typeof v.model === 'string' && v.model ? v.model : DEFAULT_LLM_SETTINGS.model,
      timeoutMs: typeof v.timeoutMs === 'number' && v.timeoutMs >= 1000 ? v.timeoutMs : DEFAULT_LLM_SETTINGS.timeoutMs,
    };
  } catch {
    return { ...DEFAULT_LLM_SETTINGS };
  }
}

const idb = typeof indexedDB !== 'undefined' ? createStore('director-studio', 'projects') : undefined;
const AUTOSAVE_KEY = 'current';

let rig: MannequinRig | null = null;
let ctx: ComposerContext | null = null;
const history = new UndoHistory<DirectorProject>();
let noticeId = 0;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

const rigRef = () => (rig ? { id: rig.definition.id, signature: rigSignature(rig.definition) } : { id: 'quaternius-ual-mannequin', signature: '' });

export const useDirector = create<DirectorState>(() => ({
  status: 'loading',
  project: newProject(rigRef()),
  perf: null,
  time: 0,
  playing: false,
  selectedObject: null,
  selectedAction: null,
  zoom: 60,
  busy: null,
  notices: [],
  canUndo: false,
  canRedo: false,
  llm: loadLlmSettings(),
  thinking: false,
}));

/** Local-model settings are per machine, so they live in localStorage rather than in the project file. */
export function setLlmSettings(patch: Partial<LlmSettings>) {
  const llm = { ...get().llm, ...patch };
  set({ llm });
  try {
    localStorage.setItem(LLM_KEY, JSON.stringify(llm));
  } catch {
    /* storage unavailable: keep the settings for this session */
  }
}

const set = useDirector.setState;
const get = useDirector.getState;

export function notify(kind: Notice['kind'], text: string) {
  const id = ++noticeId;
  set((s) => ({ notices: [...s.notices.slice(-3), { id, kind, text }] }));
  setTimeout(() => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })), kind === 'error' ? 8000 : 4500);
}

function compose(project: DirectorProject): Performance | null {
  return ctx ? composePerformance(ctx, project.scene, project.actions) : null;
}

function autosave(project: DirectorProject) {
  if (!idb) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void idbSet(AUTOSAVE_KEY, JSON.parse(serializeProject(project)), idb), 300);
}

/** Replaces the project (undoable) and recomposes the performance. */
function commit(next: DirectorProject, opts: { undoable?: boolean; keepTime?: boolean } = {}) {
  const prev = get().project;
  if (opts.undoable !== false) history.push(prev);
  const perf = compose(next);
  const time = opts.keepTime && perf ? Math.min(get().time, perf.duration) : 0;
  set({ project: next, perf, time, canUndo: history.canUndo, canRedo: history.canRedo });
  autosave(next);
}

function idFactory(project: DirectorProject) {
  let n = project.nextId;
  return { next: () => `a${n++}`, value: () => n };
}

export function getRig() {
  return rig;
}
export function getContext() {
  return ctx;
}

export async function initDirector(loaded: MannequinRig) {
  rig = loaded;
  ctx = new ComposerContext(loaded);
  let project = newProject(rigRef());
  if (idb) {
    const saved = await idbGet(AUTOSAVE_KEY, idb).catch(() => undefined);
    if (saved) {
      const v = parseProjectText(JSON.stringify(saved), rigRef());
      if (v.ok) project = v.project;
    }
  }
  history.clear();
  set({ status: 'ready', project, perf: compose(project), time: 0, playing: false, canUndo: false, canRedo: false });
}

export function setDirectorError(message: string) {
  set({ status: 'error', error: message });
}

const chatId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export interface PromptResult {
  ok: boolean;
  reply: string;
}

/** Interprets a prompt (local model if enabled, else `runPrompt`) and commits the result as one undoable step. */
export async function sendPrompt(text: string): Promise<PromptResult> {
  const s = get();
  if (!text.trim() || !ctx || s.thinking) return { ok: false, reply: '' };
  let r: ReturnType<typeof runPrompt>;
  if (s.llm.enabled) {
    set({ thinking: true });
    try {
      r = await runPromptWithModel(ctx, s.project, text, s.selectedAction, chatId, s.llm);
    } finally {
      set({ thinking: false });
    }
  } else r = runPrompt(ctx, s.project, text, s.selectedAction, chatId);
  const project = get().project;
  const next: DirectorProject = { ...project, actions: r.actions, nextId: r.nextId, chat: [...project.chat, ...r.entries] };
  commit(next, { undoable: r.changed });
  if (r.changed) set((st) => ({ time: 0, playing: true, selectedAction: st.selectedAction && r.actions.some((a) => a.id === st.selectedAction) ? st.selectedAction : null }));
  return { ok: r.ok, reply: r.reply };
}

export function undo() {
  const prev = history.undo(get().project);
  if (prev) commit(prev, { undoable: false, keepTime: true });
}
export function redo() {
  const next = history.redo(get().project);
  if (next) commit(next, { undoable: false, keepTime: true });
}

function resolveAndCommit(project: DirectorProject, actions: DirectorAction[]) {
  const ids = idFactory(project);
  const r = resolveDependencies(actions, project.scene, ids.next);
  if (r.errors.length) return notify('error', r.errors.join(' ')), false;
  if (r.notes.length) notify('info', r.notes.join(' '));
  commit({ ...project, actions: r.actions, nextId: ids.value() }, { keepTime: true });
  return true;
}

export function updateAction(id: string, patch: Partial<DirectorAction>) {
  const p = get().project;
  resolveAndCommit(p, p.actions.map((a) => (a.id === id ? { ...a, ...patch, auto: false } : a)));
}

export function deleteAction(id: string) {
  const p = get().project;
  if (resolveAndCommit(p, p.actions.filter((a) => a.id !== id))) set({ selectedAction: null });
}

export function moveAction(id: string, delta: -1 | 1) {
  const p = get().project;
  const i = p.actions.findIndex((a) => a.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= p.actions.length) return;
  const list = [...p.actions];
  [list[i], list[j]] = [list[j], list[i]];
  const ids = idFactory(p);
  const r = resolveDependencies(list, p.scene, ids.next);
  if (r.errors.length) return notify('error', `Cannot reorder: ${r.errors.join(' ')}`);
  commit({ ...p, actions: r.actions, nextId: ids.value() }, { keepTime: true });
}

export function insertPauseAfter(id: string | null, duration = 1) {
  const p = get().project;
  const ids = idFactory(p);
  const pause: DirectorAction = { id: ids.next(), type: 'pause', duration, speed: 1 };
  const i = id ? p.actions.findIndex((a) => a.id === id) : p.actions.length - 1;
  const list = [...p.actions.slice(0, i + 1), pause, ...p.actions.slice(i + 1)];
  commit({ ...p, actions: list, nextId: ids.value() }, { keepTime: true });
  set({ selectedAction: pause.id });
}

export function updateObject(id: string, patch: Partial<SceneObject>) {
  const p = get().project;
  const objects = p.scene.objects.map((o) => (o.id === id ? { ...o, ...patch } : o));
  const scene = { ...p.scene, objects };
  // Keep the glass on a surface: table top when over the table, otherwise the ground.
  if (id === 'glass' || id === 'table') {
    const glass = requireObject(scene, 'glass');
    const f = tableFrame(requireObject(scene, 'table'));
    const y = isOverTable(f, [glass.position[0], glass.position[2]]) ? f.topY : 0;
    scene.objects = scene.objects.map((o) => (o.id === 'glass' ? { ...o, position: [o.position[0], y, o.position[2]] } : o));
  }
  if (id === 'actor') scene.objects = scene.objects.map((o) => (o.id === 'actor' ? { ...o, position: [o.position[0], 0, o.position[2]] } : o));
  const next = { ...p, scene };
  const ids = idFactory(next);
  const r = resolveDependencies(p.actions, scene, ids.next);
  if (r.errors.length) return notify('error', `That placement breaks the sequence: ${r.errors.join(' ')}`);
  if (r.notes.length) notify('info', r.notes.join(' '));
  commit({ ...next, actions: r.actions, nextId: ids.value() }, { keepTime: true });
}

export function updateCamera(camera: DirectorProject['camera']) {
  const p = get().project;
  set({ project: { ...p, camera } });
  autosave(get().project);
}

export function renameProject(name: string) {
  commit({ ...get().project, name: name.slice(0, 120) || 'Untitled scene' }, { keepTime: true });
}

export function resetProject() {
  commit(newProject(rigRef()));
  set({ selectedAction: null, selectedObject: null, playing: false });
}

export function setTime(t: number) {
  const perf = get().perf;
  set({ time: Math.max(0, Math.min(perf?.duration ?? 0, t)) });
}

export function tick(dt: number) {
  const s = get();
  if (!s.playing || !s.perf) return;
  let t = s.time + dt;
  if (t >= s.perf.duration) {
    if (s.project.settings.loop && s.perf.duration > 0) t %= s.perf.duration;
    else return set({ time: s.perf.duration, playing: false });
  }
  set({ time: t });
}

export function togglePlay() {
  const s = get();
  if (!s.perf || s.perf.duration <= 0) return;
  if (!s.playing && s.time >= s.perf.duration) set({ time: 0 });
  set({ playing: !s.playing });
}

export function setLoop(loop: boolean) {
  const p = get().project;
  set({ project: { ...p, settings: { ...p.settings, loop } } });
}

function download(data: BlobPart, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const safeName = (n: string) => n.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'scene';

export function bakeCurrent(): MotionData | null {
  const s = get();
  if (!rig || !s.perf || s.project.actions.length === 0) {
    notify('error', 'Nothing to export yet: direct a performance first.');
    return null;
  }
  const motion = bakeActorMotion(s.perf, rig.definition, rig.rawHeight, s.project.name);
  const v = validateMotion(JSON.parse(JSON.stringify(motion)), rig.definition);
  if (!v.ok) {
    notify('error', `Baked motion failed validation: ${v.errors.join(' ')}`);
    return null;
  }
  return v.motion;
}

export function saveProjectFile() {
  const p = get().project;
  download(serializeProject(p), `${safeName(p.name)}${PROJECT_EXTENSION}`, 'application/json');
  notify('success', 'Project saved.');
}

export async function openProjectFile(file: File) {
  const v = parseProjectText(await file.text(), rigRef());
  if (!v.ok) return notify('error', `Cannot open ${file.name}: ${v.errors.join(' ')}`);
  commit(v.project);
  set({ selectedAction: null, selectedObject: null, playing: false });
  notify('success', `Opened ${v.project.name}.`);
}

export function exportMotionJson() {
  const m = bakeCurrent();
  if (!m) return;
  download(JSON.stringify(m), `${safeName(m.name)}.motion.json`, 'application/json');
  notify('success', 'Motion JSON exported (MotionRecorder format).');
}

async function guarded(label: string, fn: () => Promise<void>) {
  set({ busy: label });
  try {
    await fn();
  } catch (e) {
    notify('error', `${label} failed: ${(e as Error).message}`);
  } finally {
    set({ busy: null });
  }
}

export function exportActorGlb() {
  return guarded('Actor GLB export', async () => {
    const m = bakeCurrent();
    if (!m || !rig) return;
    const bytes = await exportMotionGlb(rig.sourceBytes, m, rig.definition);
    const check = await importMotionGlb(bytes.slice().buffer as ArrayBuffer, rig.definition);
    if (check.motions.length !== 1) throw new Error(`re-import check failed (${check.errors.join(' ')})`);
    download(bytes as Uint8Array<ArrayBuffer>, `${safeName(m.name)}.glb`, 'model/gltf-binary');
    notify('success', 'Actor GLB exported and re-import verified.');
  });
}

export function exportFullSceneGlb() {
  return guarded('Scene GLB export', async () => {
    const m = bakeCurrent();
    const perf = get().perf;
    if (!m || !rig || !perf) return;
    const glass = bakeGlass(perf);
    const bytes = await exportSceneGlb(rig.sourceBytes, m, rig.definition, get().project.scene, glass);
    const check = await verifySceneGlb(bytes, rig.definition, glass);
    if (!check.ok) throw new Error(check.errors.join(' '));
    download(bytes as Uint8Array<ArrayBuffer>, `${safeName(m.name)}.scene.glb`, 'model/gltf-binary');
    notify('success', 'Scene GLB exported (actor, table, glass) and re-import verified.');
  });
}

/** Stores the baked actor motion as a MotionRecorder take. Returns true on success. */
export async function sendToRecorder(): Promise<boolean> {
  const m = bakeCurrent();
  if (!m) return false;
  const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `d${Date.now()}`;
  await saveRecording({ id, motion: { ...m, name: `Director: ${m.name}` } });
  const p = get().project;
  set({ project: { ...p, motionRefs: [...p.motionRefs, m.name] } });
  autosave(get().project);
  return true;
}
