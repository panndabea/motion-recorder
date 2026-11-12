# Text-to-Motion experiment (branch `experiment/text-to-motion`, not for merge)

Isolated page: **`/lab/text-to-motion`** (`src/lab/textToMotion/`). It does not import or touch `src/director/`.
The only shared-core change is that `MotionMeta.source` accepts `'generative'` and keeps an optional
`meta.generator` provenance object (model, revision, runtime, prompt, seed, fps, frames, latency, timings).

## Pipeline

```
prompt ─▶ MotionGenerator ─▶ GeneratedMotion (raw model joints: global rotations + positions, model skeleton)
            ├─ ArdyWebGpuGenerator   browser, ONNX Runtime Web / WebGPU, ARDY Mini Core40 (Core27, 20 fps)
            └─ KimodoHttpGenerator   self-hosted kimodo.cpp + Kimodo-SOMA-RP-v1.2 (SOMA30, 30 fps)
        ─▶ retargetToMannequin ─▶ MotionData (local quaternions for DEF-* bones + DEF-hips translation)
        ─▶ MotionPlayer preview on public/models/mannequin.glb
        ─▶ existing serializeMotion / exportMotionGlb ─▶ parseMotionJson / importMotionGlb (roundtrip check in-page)
```

No animation clip of the mannequin is used anywhere in the lab. If a backend fails (no WebGPU, backend
down, invalid output) the page shows the error and clears the preview; nothing is substituted.

### Retargeting

Both model skeletons and the mannequin are Y-up, +Z forward, +X = character's left, rest = T-pose, and both
models emit *global* joint rotations relative to their rest pose (identity = rest). Per mapped bone:

`targetGlobal(t) = sourceGlobal(t) · align · targetRestGlobal`, `local = parentGlobal⁻¹ · targetGlobal`

`align` is the swing that turns the mannequin's rest bone direction onto the source's rest bone direction
(absorbs proportion/pose differences, e.g. ARDY's spine curvature: 17°/10°, foot pitch: ~11°). Clavicles
(`noAlign`) transfer only the delta from rest, because their rest directions differ by design (~38°).
Unmapped mannequin bones (fingers, `DEF-spine`-less joints, toes' children) keep rest rotation. The hips path is
scaled by hips-height ratio (ARDY 0.96, SOMA 0.93) and written to `DEF-hips` translation (`rootMotion: 'clip'`).

Mapping: ARDY `Spine2` folds into `Spine3`; SOMA `Neck2`, `Jaw`, eyes and hand end-effectors are dropped
(the mannequin's fingers are not driven by either model — neither model generates fingers).

## Results (this VM: 8 vCPU, 31 GiB RAM, **no GPU**)

All runs: seed 42, 6 s requested. ARDY ran in headless Chromium with **software WebGPU (SwiftShader, no
`shader-f16` → fp32 graphs)**; Kimodo ran in kimodo.cpp on the **CPU** in Docker. The two backends partly ran
at the same time on the 8 vCPUs, so latencies are upper bounds for this VM, not hardware numbers.

| Prompt | Backend | Frames | Latency | Hips height (m, min–max) | Root travel | Min toe height | Toe slide* | JSON / GLB reimport (max Δ) |
|---|---|---|---|---|---|---|---|---|
| walking slowly while crouching forward | ARDY Mini | 120 @ 20 fps | 1263 s (text 21 s, denoise 1197 s, decode 44 s) | 0.53–0.64 | 5.2 m | 0.033 | 0.54 m | 0° / 0° |
| ″ | Kimodo v1.2 | 180 @ 30 fps | 745 s (cold CLI incl. load) | 0.57–0.67 | 4.9 m | 0.044 | 1.67 m | 0° / 0.0001° |
| ″ | Kimodo HF Space (ZeroGPU) | 180 @ 30 fps | 8.2 s generation, 21.8 s wall | – (BVH/NPZ only, not imported) | | | | – |
| stumbling, losing balance, and recovering | ARDY Mini | 120 @ 20 fps | 641 s | 0.80–0.89 | 1.2 m | 0.033 | 0.30 m | 0° / 0.0001° |
| ″ | Kimodo v1.2 | 180 @ 30 fps | 757 s | 0.73–0.89 | 2.9 m | 0.033 | 0.32 m | 0° / 0° |
| ″ | Kimodo HF Space | **failed**: “You have exceeded your ZeroGPU runs limit” (anonymous quota; no token used) | | | | | | |
| looking around nervously before sitting down | ARDY Mini | 120 @ 20 fps | 902 s | 0.50–0.51 | 0.01 m | 0.053 | 0.16 m | 0° / 0° |
| ″ | Kimodo v1.2 | 180 @ 30 fps | 785 s | 0.51–0.90 | 1.0 m | 0.051 | 0.81 m | 0° / 0° |
| ″ | Kimodo HF Space | **failed**: ZeroGPU quota (as above) | | | | | | |

\* horizontal toe travel while the toe is within 3 cm of its lowest height (proxy for foot sliding; walking
steps legitimately add some). Mannequin rest hips height is 0.88 m.

Memory: ARDY fp32 transfer 684 MiB (cached in Cache Storage after the first load, 58 s download + session
creation here); during generation the Chromium GPU process used ~1.3 GB RSS and the renderer ~1.8 GB; JS heap
stayed at ~80 MiB. Kimodo: motion GGUF 1.13 GB + Q8_0 text encoder 8.1 GB (memory-mapped), container peak
3.1 GiB RSS; official PyTorch Kimodo additionally needs the gated `meta-llama/Meta-Llama-3-8B-Instruct`.

Determinism: ARDY Mini rerun of prompt 2 with seed 42 reproduced the take (max track-value difference 0; 496 s when running alone). kimodo.cpp on CPU is **not** bit-reproducible: rerunning prompt 1 with seed 42 gave the same kind of motion but differences of up to 0.13 in quaternion components and 0.21 m in joint positions (multithreaded CPU kernels). Reproducibility therefore comes from the stored take (Motion JSON/GLB), not from regenerating.

Roundtrip: every take was exported to Motion JSON and GLB with the existing exporters, re-imported with the
existing importers into a fresh rig and compared over 41 samples (max local-rotation Δ). Done in-browser
(“Verify export → reimport”) and offline (`T2M_DIR=… npx vitest run tests/unit/textToMotion.live.test.ts`).

## Evaluation

- **Genuinely generated.** Every take comes from a diffusion model sampled at request time for the typed prompt
  (provenance in `meta.generator` shows model, revision, runtime, seed and per-stage timings). The three prompts
  produce clearly different motion: low crouched gait (hips ≈0.6 m) with forward travel, an upright stagger with
  arm flailing (Kimodo) or a smaller sway/step (ARDY), and a transition into a seated pose.
- **Browser-local viability (ARDY Mini).** Works end-to-end in the browser without any token or server. On this
  GPU-less VM software WebGPU needs 10–21 min per 6 s clip, so it is only a correctness proof here; ARDY Mini's
  own reports and the architecture (10 DDIM steps × 3 windows) suggest seconds on a real GPU, but that is **not
  measured** in this experiment. Requires a WebGPU browser (Chrome/Edge); without an adapter the lab reports the
  failure (covered by an E2E test).
- **Kimodo-SOMA-RP-v1.2.** Not browser-viable (282 M motion params + 8 B-param Llama-3 text encoder). Runs
  self-hosted via kimodo.cpp after converting the v1.2 safetensors to GGUF (v1.2 is not in kimodo.cpp's model
  list; same `SOMASkeleton30` architecture, conversion succeeded with 414 tensors). ~12.5 min per clip on 8 CPU
  cores; needs a GPU (Vulkan/CUDA) for interactive use. The free HF Space generated only 1 of 3 prompts before the
  anonymous ZeroGPU quota ran out; I did not use a Hugging Face token.
- **Motion quality.** Kimodo looks more expressive (bigger stumble, clear stand→sit); ARDY Mini's stumble is mild.
  Prompt adherence gaps: neither model clearly “walks slowly” (≈0.8–0.9 m/s); ARDY prompt 3 starts already seated
  and skips the “looking around before” part; Kimodo prompt 3 sits after some turning but the “nervous” glances
  are weak. Both sit on nothing (no chair/scene conditioning). Feet hover 3–5 cm above the floor after scaling and
  there is visible foot sliding on the Kimodo crouch walk; no contact cleanup/IK is applied (on purpose: raw model output).
- **Retargeting issues.** Rest directions differ by up to 17° (ARDY spine), ~10° (feet) and ~38° (clavicles,
  handled as delta-only); limbs align within 1°. Fingers, jaw, eyes are not generated and stay at rest. One
  spine joint is folded on each source skeleton. Height is matched by hips height, not limb lengths, so hands/feet
  can be off by a few cm. Root heading is taken as generated (no re-orientation).
- **Export.** JSON and GLB roundtrips are lossless for all six takes (≤0.0001°). GLB keeps the motion but not the
  `meta.generator` provenance (only Motion JSON carries it).

## Licenses

| Component | Used as | License |
|---|---|---|
| `intsuc/Llama-3-ARDY-Mini-Core40-Browser` @ `1c21362` (ONNX weights, downloaded by the browser, not vendored) | ARDY motion denoiser/decoder | NVIDIA Open Model License (+ NVIDIA Trustworthy AI terms); required notice “Licensed by NVIDIA Corporation under the NVIDIA Open Model License” |
| … its MiniLM text encoder | text conditioning | Apache-2.0 (derived from `sentence-transformers/all-MiniLM-L6-v2`); distilled from a teacher “Built with Meta Llama 3” → Meta Llama 3 Community License + AUP apply to the lineage; LLM2Vec teacher components MIT; SEED Timeline Annotations CC BY 4.0. See the repo's `MODEL_TERMS.md`, `NOTICE`, `LICENSES/` |
| ARDY Mini browser runtime (`src/lab/textToMotion/ardy/`, vendored from `intsuc/ardy-mini@5e9ce2d`) | inference code | Apache-2.0 (derivative of NVIDIA `nv-tlabs/ardy`, Apache-2.0); `LICENSE` + `NOTICE` kept |
| `onnxruntime-web` 1.27.0 | WebGPU runtime | MIT |
| `@huggingface/tokenizers` 0.1.3 | tokenizer | Apache-2.0 |
| `nvidia/Kimodo-SOMA-RP-v1.2` @ `0e3c890` (server-side only, not distributed) | Kimodo motion model | NVIDIA Open Model License; trained on Bones Rigplay data |
| `LocalAI-io/Llama-3-Kimodo-GGML` Q8_0 (server-side only) | Kimodo text encoder (Llama-3-8B-Instruct + LLM2Vec) | Meta Llama 3 Community License + AUP (“Built with Meta Llama 3”), LLM2Vec MIT |
| `kimodo.cpp` (Docker image built locally, not vendored) | native runtime | Apache-2.0 |
| `experiments/kimodo-server/server.py` | backend adapter | this repository |

The NVIDIA Open Model License and Llama 3 license impose use restrictions and attribution; this experiment
is evaluation-only and does not redistribute weights.
