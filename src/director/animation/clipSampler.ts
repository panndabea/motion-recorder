import { Quaternion, Vector3, type AnimationClip } from 'three';
import type { RigDefinition } from '../../rig/rigDefinition';
import { clipToTracks } from '../../recording/motionPlayback';

interface SampledTrack {
  bone: string;
  rotation: boolean;
  times: Float64Array;
  values: Float64Array;
  width: number;
}

/** Looping, allocation-light sampler for one library clip (local transforms by original bone name). */
export class ClipSampler {
  readonly duration: number;
  readonly name: string;
  private readonly tracks: SampledTrack[];
  private readonly qa = new Quaternion();
  private readonly qb = new Quaternion();

  constructor(clip: AnimationClip, def: RigDefinition) {
    this.name = clip.name;
    this.duration = clip.duration;
    this.tracks = clipToTracks(clip, def).map((t) => {
      const width = t.property === 'rotation' ? 4 : 3;
      return { bone: t.bone, rotation: t.property === 'rotation', times: Float64Array.from(t.times), values: Float64Array.from(t.values.flat()), width };
    });
  }

  /** Writes the clip pose at time t (wrapped into the loop) into the maps. */
  sample(t: number, rotations: Map<string, Quaternion>, translations: Map<string, Vector3>) {
    const d = this.duration;
    const time = d > 0 ? ((t % d) + d) % d : 0;
    for (const tr of this.tracks) {
      const { times, values, width } = tr;
      let hi = 0;
      while (hi < times.length - 1 && times[hi] < time) hi++;
      const lo = Math.max(0, times[hi] > time ? hi - 1 : hi);
      const span = times[hi] - times[lo];
      const a = span > 0 ? Math.min(1, Math.max(0, (time - times[lo]) / span)) : 0;
      if (tr.rotation) {
        this.qa.fromArray(values, lo * width);
        this.qb.fromArray(values, hi * width);
        const out = rotations.get(tr.bone) ?? new Quaternion();
        rotations.set(tr.bone, out.slerpQuaternions(this.qa, this.qb, a).normalize());
      } else {
        const out = translations.get(tr.bone) ?? new Vector3();
        translations.set(
          tr.bone,
          out.set(
            values[lo * 3] + (values[hi * 3] - values[lo * 3]) * a,
            values[lo * 3 + 1] + (values[hi * 3 + 1] - values[lo * 3 + 1]) * a,
            values[lo * 3 + 2] + (values[hi * 3 + 2] - values[lo * 3 + 2]) * a,
          ),
        );
      }
    }
  }
}
