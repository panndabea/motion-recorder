# ARDY Mini browser runtime (vendored)

Copied from `web/src/runtime/` of https://github.com/intsuc/ardy-mini at commit `5e9ce2da35af26583646cc8b73ac04b13a7c604a`
(Apache-2.0, see `LICENSE` and `NOTICE`; ARDY Mini is an unofficial derivative of NVIDIA's Apache-2.0 `nv-tlabs/ardy`).

MotionRecorder modifications, each marked with "Modified for MotionRecorder":
- `sessions.ts`: ONNX Runtime WebAssembly host files are resolved through Vite `?url` imports; minimal local `GPUAdapter` type.
- `windows.ts`: dropped an unused destructured variable (lint).

The model weights are **not** vendored. They are downloaded by the browser from the public, revision-pinned
Hugging Face repository `intsuc/Llama-3-ARDY-Mini-Core40-Browser` and are governed by its composite
`MODEL_TERMS.md` (NVIDIA Open Model License, Meta Llama 3 Community License lineage, Apache-2.0, MIT, CC BY 4.0).
