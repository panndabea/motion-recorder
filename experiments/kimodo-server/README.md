# Self-hosted Kimodo backend (experimental)

`server.py` is a small standard-library HTTP wrapper around the `kmd-generate --server` worker of
[kimodo.cpp](https://github.com/localai-org/kimodo.cpp) (Apache-2.0). The Text-to-Motion lab talks to it
through `KimodoHttpGenerator` (`src/lab/textToMotion/generators/kimodoHttp.ts`): the browser sends
`{prompt, seconds, seed}` and receives raw SOMA30 joints (global xyzw rotations + joint positions).
Weights and any Hugging Face credentials stay on the server; nothing is billed.

Tested setup (CPU only, no GPU):

```bash
git clone https://github.com/localai-org/kimodo.cpp && cd kimodo.cpp
docker build -t kimodo-cpp:local .
# Kimodo-SOMA-RP-v1.2 (NVIDIA Open Model License, ungated) and the LLM2Vec/Llama-3 text encoder GGUF
huggingface-cli download nvidia/Kimodo-SOMA-RP-v1.2 --local-dir w/Kimodo-SOMA-RP-v1.2
huggingface-cli download LocalAI-io/Llama-3-Kimodo-GGML Llama-3-Kimodo-Q8_0.gguf tokenizer.gguf --local-dir w/Llama-3-Kimodo-GGML
# kimodo.cpp's converter only lists v1.1: add the v1.2 id (same SOMASkeleton30 architecture) to MODEL_SPECS
# in scripts/convert_motion_to_gguf.py, then write "<hub sha> nvidia/Kimodo-SOMA-RP-v1.2" to REVISION.
python3 scripts/convert_motion_to_gguf.py --input w/Kimodo-SOMA-RP-v1.2 --output w/kimodo-soma-rp-v1.2.gguf

docker run -d --name kmd-server -p 127.0.0.1:8787:8787 -e KIMODO_HOST=0.0.0.0 -e KIMODO_BACKEND=cpu \
  -e KMD_GENERATE=/app/bin/kmd-generate -e KIMODO_MOTION=/w/kimodo-soma-rp-v1.2.gguf \
  -e KIMODO_TEXT=/w/Llama-3-Kimodo-GGML/Llama-3-Kimodo-Q8_0.gguf \
  -v $PWD/w:/w:ro -v /path/to/motion-recorder/experiments/kimodo-server:/srv:ro \
  --entrypoint python3 kimodo-cpp:local /srv/server.py --port 8787 --allow-origin http://localhost:5173
```

Then pick “Kimodo SOMA-RP v1.2 · self-hosted HTTP” in `/lab/text-to-motion`. With an NVIDIA/AMD GPU,
use `KIMODO_BACKEND=vulkan`. The server is bound to localhost and has no authentication; do not expose it publicly.

Any other implementation (e.g. official PyTorch Kimodo on a GPU box) can replace it as long as it serves
`POST /generate` with the response format documented in `KimodoResponse`.
