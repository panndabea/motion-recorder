import { Vector3 } from 'three';

/** MediaPipe Pose landmark indices (33-point BlazePose topology). Left/right are the subject's. */
export const LM = {
  nose: 0,
  leftEyeInner: 1,
  leftEye: 2,
  leftEyeOuter: 3,
  rightEyeInner: 4,
  rightEye: 5,
  rightEyeOuter: 6,
  leftEar: 7,
  rightEar: 8,
  mouthLeft: 9,
  mouthRight: 10,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftPinky: 17,
  rightPinky: 18,
  leftIndex: 19,
  rightIndex: 20,
  leftThumb: 21,
  rightThumb: 22,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
  leftHeel: 29,
  rightHeel: 30,
  leftFootIndex: 31,
  rightFootIndex: 32,
} as const;

export const LANDMARK_COUNT = 33;

export const POSE_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [11, 12], [11, 23], [12, 24], [23, 24],
  [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  [23, 25], [25, 27], [27, 29], [27, 31], [29, 31],
  [24, 26], [26, 28], [28, 30], [28, 32], [30, 32],
  [0, 7], [0, 8], [9, 10],
];

export interface RawLandmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

/**
 * One tracked pose, independent of MediaPipe types.
 * `world` is MediaPipe's metric, hip-centred space: +x = image right (subject's left), +y down, +z away from camera.
 * `image` is normalised image space of the *unmirrored* camera frame (0..1).
 */
export interface PoseFrame {
  timestamp: number;
  world: RawLandmark[];
  image: RawLandmark[];
}

/**
 * Body space used by the retargeter: three.js / mannequin model conventions
 * (+X = subject's left, +Y up, +Z towards the camera = subject's forward), metres, hip-centred.
 * The conversion from MediaPipe world space is a 180° rotation about X (handedness is preserved).
 */
export interface BodyFrame {
  timestamp: number;
  points: Vector3[];
  visibility: number[];
}

export function mediaPipeToBody(frame: PoseFrame): BodyFrame {
  return {
    timestamp: frame.timestamp,
    points: frame.world.map((p) => new Vector3(p.x, -p.y, -p.z)),
    visibility: frame.world.map((p) => p.visibility ?? 1),
  };
}

export function bodyToMediaPipe(p: Vector3): { x: number; y: number; z: number } {
  return { x: p.x, y: -p.y, z: -p.z };
}
