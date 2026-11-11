import { parseMannequin } from '../rig/mannequinLoader';
import { rigSignature, type RigDefinition } from '../rig/rigDefinition';
import { clipToTracks } from '../recording/motionPlayback';
import { MOTION_FORMAT, MOTION_VERSION, rigInfo, validateMotion, type MotionData } from '../recording/motionFormat';

export interface GlbImportResult {
  motions: MotionData[];
  errors: string[];
  warnings: string[];
}

/**
 * Loads a GLB of the same mannequin (e.g. one exported by MotionRecorder) into a fresh rig instance
 * and converts its animations back into motion data.
 */
export async function importMotionGlb(bytes: ArrayBuffer, rig: RigDefinition, maxClips = 64): Promise<GlbImportResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  let fresh;
  try {
    fresh = await parseMannequin(bytes);
  } catch (e) {
    return { motions: [], errors: [`Could not read GLB: ${(e as Error).message}`], warnings };
  }
  if (rigSignature(fresh.definition) !== rigSignature(rig)) {
    return { motions: [], errors: ['The GLB skeleton does not match the mannequin rig.'], warnings };
  }
  if (fresh.clips.length === 0) return { motions: [], errors: ['The GLB contains no animations.'], warnings };
  if (fresh.clips.length > maxClips) warnings.push(`Only the first ${maxClips} of ${fresh.clips.length} animations were imported.`);
  const motions: MotionData[] = [];
  for (const clip of fresh.clips.slice(0, maxClips)) {
    const tracks = clipToTracks(clip, rig);
    const keyCount = Math.max(...tracks.map((t) => t.times.length));
    const candidate = {
      format: MOTION_FORMAT,
      version: MOTION_VERSION,
      name: clip.name || 'GLB animation',
      createdAt: new Date().toISOString(),
      duration: clip.duration,
      fps: keyCount > 1 && clip.duration > 0 ? Math.round((keyCount - 1) / clip.duration) : 30,
      frameCount: keyCount,
      space: 'local',
      quaternionOrder: 'xyzw',
      interpolation: 'linear',
      rig: rigInfo(rig, fresh.rawHeight),
      tracks,
      meta: { source: 'glb-import', rootMotion: 'clip' },
    };
    const v = validateMotion(candidate, rig);
    if (v.ok) motions.push(v.motion);
    else errors.push(`${clip.name}: ${v.errors.join(' ')}`);
    warnings.push(...v.warnings);
  }
  return { motions, errors, warnings };
}
