import { create } from 'zustand';
import type { CameraDevice } from '../tracking/camera';
import type { StoredRecording } from '../storage/recordingStore';

/** Single application mode; exactly one subsystem owns the mannequin bones in each. */
export type AppMode = 'cameraDisabled' | 'tracking' | 'calibrating' | 'ready' | 'recording' | 'playback';

export type CameraState = 'off' | 'starting' | 'on' | 'error';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'warning' | 'error';
  text: string;
}

export interface AppState {
  rigStatus: 'loading' | 'ready' | 'error';
  rigError: string | null;
  mode: AppMode;
  camera: CameraState;
  cameraMessage: string | null;
  cameras: CameraDevice[];
  selectedCamera: string | null;
  sourceKind: 'webcam' | 'synthetic';
  tracking: {
    personDetected: boolean;
    fps: number;
    inferenceMs: number;
    frameStride: number;
    lostBones: number;
    delegate: string | null;
  };
  calibration: { calibrated: boolean; legsTracked: boolean; progress: number; message: string };
  recordings: StoredRecording[];
  selectedId: string | null;
  recordingElapsed: number;
  newRecordingName: string;
  playback: { time: number; duration: number; playing: boolean; loop: boolean };
  grounding: boolean;
  toasts: Toast[];
}

export const initialState: AppState = {
  rigStatus: 'loading',
  rigError: null,
  mode: 'cameraDisabled',
  camera: 'off',
  cameraMessage: null,
  cameras: [],
  selectedCamera: null,
  sourceKind: 'webcam',
  tracking: { personDetected: false, fps: 0, inferenceMs: 0, frameStride: 1, lostBones: 0, delegate: null },
  calibration: { calibrated: false, legsTracked: false, progress: 0, message: 'Not calibrated' },
  recordings: [],
  selectedId: null,
  recordingElapsed: 0,
  newRecordingName: 'Take 1',
  playback: { time: 0, duration: 0, playing: false, loop: true },
  grounding: true,
  toasts: [],
};

export const useStore = create<AppState>()(() => initialState);

let toastId = 0;
export function toast(kind: Toast['kind'], text: string, ms = kind === 'error' ? 8000 : 4000) {
  const id = ++toastId;
  useStore.setState((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
  setTimeout(() => useStore.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
}

export const MODE_LABEL: Record<AppMode, string> = {
  cameraDisabled: 'Camera Disabled',
  tracking: 'Tracking',
  calibrating: 'Calibrating',
  ready: 'Ready',
  recording: 'Recording',
  playback: 'Playback',
};
