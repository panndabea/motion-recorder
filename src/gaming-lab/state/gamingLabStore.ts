import { create } from 'zustand';
import type { Params } from '../engine/experiment';

export type CompareMode = 'single' | 'split';
export type CameraPreset = 'front' | 'side' | 'three-quarter' | 'top' | 'close-up' | 'wide';

/** Shared, mutable playback clock (read every frame without React re-renders). */
export const labClock = { time: 0, duration: 1 };

interface LabState {
  experimentId: string;
  params: Record<string, Params>;
  playing: boolean;
  speed: number;
  loop: boolean;
  compare: CompareMode;
  debug: boolean;
  skeleton: boolean;
  axes: boolean;
  camera: CameraPreset;
  /** Bumped to force re-sync of displayed time / camera. */
  tick: number;
  cameraNonce: number;
  select: (id: string, camera?: CameraPreset) => void;
  setParam: (id: string, key: string, value: Params[string]) => void;
  setParams: (id: string, values: Partial<Params>) => void;
  resetParams: (id: string, defaults: Params) => void;
  set: (partial: Partial<Omit<LabState, 'select' | 'setParam' | 'setParams' | 'resetParams' | 'set'>>) => void;
}

export const useLab = create<LabState>((set) => ({
  experimentId: 'inverse-kinematics',
  params: {},
  playing: true,
  speed: 1,
  loop: true,
  compare: 'single',
  debug: true,
  skeleton: false,
  axes: false,
  camera: 'three-quarter',
  tick: 0,
  cameraNonce: 0,
  select: (experimentId, camera = 'three-quarter') => {
    labClock.time = 0;
    set((s) => ({ experimentId, tick: s.tick + 1, camera, cameraNonce: s.cameraNonce + 1 }));
  },
  setParam: (id, key, value) => set((s) => ({ params: { ...s.params, [id]: { ...s.params[id], [key]: value } } })),
  setParams: (id, values) => set((s) => ({ params: { ...s.params, [id]: { ...s.params[id], ...(values as Params) } } })),
  resetParams: (id, defaults) => set((s) => ({ params: { ...s.params, [id]: { ...defaults } } })),
  set: (partial) => set(partial),
}));
