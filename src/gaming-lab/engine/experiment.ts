import type { Object3D } from 'three';
import type { LabActor } from './labActor';

export type ParamValue = number | boolean | string;
export type Params = Record<string, ParamValue>;

export type ControlSpec =
  | { key: string; label: string; type: 'range'; min: number; max: number; step: number }
  | { key: string; label: string; type: 'toggle' }
  | { key: string; label: string; type: 'select'; options: string[] };

export interface Preset {
  name: string;
  params: Partial<Params>;
}

/** Per-actor scratch state an experiment may keep (e.g. foot locks); rebuilt by `reset`. */
export type ExperimentState = Record<string, unknown>;

export interface EvalContext {
  actor: LabActor;
  /** Lab time in seconds (shared clock). */
  t: number;
  params: Params;
  /** False for the split-screen baseline (technique disabled). */
  enabled: boolean;
  state: ExperimentState;
  /** Debug group in lab world space; cleared every frame. */
  debug: Object3D | null;
  /** Props created by `createProps` for this view (absent while baking). */
  props?: Object3D[];
}

export interface Experiment {
  id: string;
  title: string;
  /** Loop length of the demo timeline (s). */
  duration: (params: Params) => number;
  defaults: Params;
  controls: ControlSpec[];
  presets: Preset[];
  /** Name of the main on/off parameter; split-screen forces it off on the left. */
  toggleKey: string;
  /** Scene props (cube, table, markers) owned by the experiment, created per actor view. */
  createProps?: (actor: LabActor) => Object3D[];
  /**
   * Pure evaluation: builds the full pose of `actor` for time t. Experiments with history
   * (foot locking, springs) re-simulate deterministically from t=0 inside `state`.
   */
  evaluate: (ctx: EvalContext) => void;
  /** Readouts shown under the controls (error distances, scores …). */
  readouts?: (ctx: EvalContext) => Record<string, string>;
  /** Draggable world-space handles bound to three numeric params (x, y, z in metres). */
  handles?: { id: string; keys: [string, string, string]; color: string; when?: (params: Params) => boolean }[];
  /** Camera preset applied when the experiment is opened. */
  camera?: 'front' | 'side' | 'three-quarter' | 'top' | 'close-up' | 'wide';
  /** Optional 2D chart (e.g. time-mapping curve) shown in the controls panel. */
  chart?: (params: Params, t: number) => LabChart;
  /** Whether baking/export is meaningful for this experiment. */
  bakeable: boolean;
}

export interface LabChart {
  title: string;
  xLabel: string;
  yLabel: string;
  series: { name: string; color: string; points: [number, number][]; dashed?: boolean }[];
  markers?: { x: number; y: number; color: string }[];
  cursorX?: number;
}
