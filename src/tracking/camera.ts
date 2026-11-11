export interface CameraDevice {
  deviceId: string;
  label: string;
}

export async function listCameras(): Promise<CameraDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'videoinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
}

export class CameraError extends Error {}

/** Opens a local webcam stream. Frames never leave the browser. */
export async function openCamera(deviceId?: string): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraError('This browser does not support camera access (getUserMedia). Use a recent Chrome, Edge or Firefox over https or localhost.');
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
        facingMode: deviceId ? undefined : 'user',
      },
    });
  } catch (e) {
    const err = e as DOMException;
    const reasons: Record<string, string> = {
      NotAllowedError: 'Camera permission was denied. Allow camera access in the browser address bar and try again.',
      NotFoundError: 'No camera was found.',
      NotReadableError: 'The camera is in use by another application.',
      OverconstrainedError: 'The selected camera is not available.',
      SecurityError: 'Camera access requires a secure context (https or localhost).',
    };
    throw new CameraError(reasons[err.name] ?? `Could not open the camera: ${err.message}`);
  }
}

export function stopStream(stream: MediaStream | null | undefined) {
  stream?.getTracks().forEach((t) => t.stop());
}
