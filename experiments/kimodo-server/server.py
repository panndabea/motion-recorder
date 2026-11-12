#!/usr/bin/env python3
"""Minimal self-hosted Kimodo backend for the MotionRecorder Text-to-Motion lab.

Wraps the kimodo.cpp `kmd-generate` worker (Apache-2.0, https://github.com/localai-org/kimodo.cpp) and
returns raw generated SOMA30 joints as JSON. Model weights and any credentials stay on this machine;
the browser only sends {prompt, seconds, seed}. Standard library only.

  KMD_GENERATE=/app/bin/kmd-generate KIMODO_MOTION=/w/kimodo-soma-rp-v1.2.gguf \
  KIMODO_TEXT=/w/Llama-3-Kimodo-Q8_0.gguf python3 server.py --port 8787
"""
import argparse, json, os, struct, subprocess, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

NAMES = ["Hips", "Spine1", "Spine2", "Chest", "Neck1", "Neck2", "Head", "Jaw", "LeftEye", "RightEye",
         "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand", "LeftHandThumbEnd", "LeftHandMiddleEnd",
         "RightShoulder", "RightArm", "RightForeArm", "RightHand", "RightHandThumbEnd", "RightHandMiddleEnd",
         "LeftLeg", "LeftShin", "LeftFoot", "LeftToeBase", "RightLeg", "RightShin", "RightFoot", "RightToeBase"]
PARENTS = [-1, 0, 1, 2, 3, 4, 5, 6, 6, 6, 3, 10, 11, 12, 13, 13, 3, 16, 17, 18, 19, 19, 0, 22, 23, 24, 0, 26, 27, 28]
# SOMA30 rest offsets (metres) as published in kimodo.cpp scripts/export_glb.py.
OFFSETS = [[0.0, 0.988, 0.0], [-0.00013727, 0.0500376256, -0.00053726669], [0, 0.0712530139, -0.000298248546],
           [0, 0.0755006305, -0.00815970992], [-0.00181676517, 0.263112953, -0.00553348292], [0, 0.0770939664, 0.0230258546],
           [0, 0.0612891595, 0.0195370861], [2.63687901e-05, 0.0047559225, 0.0309494062], [0.0320638079, 0.0538020513, 0.0758688308],
           [-0.0322244017, 0.05361869, 0.0755823359], [0.0162165175, 0.232371641, 0.0511341324], [0.149198457, 0, -0.0550232576],
           [0.287393078, 0, -2.58787737e-05], [0.270939812, 0, 2.60897248e-05], [0.122686267, -0.0322017573, 0.0483306876],
           [0.190119595, -0.00312878387, -0.000339570373], [-0.0138011824, 0.231803086, 0.0521415786], [-0.150371962, 0, -0.0554560437],
           [-0.287366393, 0, -2.59709359e-05], [-0.271336198, 0, 2.61269368e-05], [-0.122642483, -0.0321145448, 0.0480403904],
           [-0.190005945, -0.00306615542, -0.0003157343], [0.10043214, -0.0843452671, 0.0259565473], [0, -0.432217537, -0.00802912805],
           [0, -0.421550959, -0.0348152298], [0.0, -0.0505947206, 0.132315294], [-0.10047278, -0.0829525995, 0.0262031695],
           [0, -0.433622059, -0.00805555828], [0, -0.421173943, -0.0347839785], [0, -0.0507960932, 0.132841956]]
FPS = 30


def qmul(a, b):
    ax, ay, az, aw = a; bx, by, bz, bw = b
    return (aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz)


def qrot(q, v):
    x, y, z, w = q
    t = (2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0]))
    return (v[0] + w * t[0] + y * t[2] - z * t[1], v[1] + w * t[1] + z * t[0] - x * t[2], v[2] + w * t[2] + x * t[1] - y * t[0])


def rest_positions():
    out = []
    for j, p in enumerate(PARENTS):
        o = OFFSETS[j]
        out.append(list(o) if p < 0 else [out[p][k] + o[k] for k in range(3)])
    return out


def read_f32(path):
    with open(path, "rb") as f:
        data = f.read()
    return struct.unpack(f"<{len(data) // 4}f", data)


def forward(local, roots):
    """Local xyzw rotations + root positions -> global rotations and joint positions."""
    J = len(NAMES)
    frames = len(roots) // 3
    rots, pos = [], []
    for f in range(frames):
        g, p = [None] * J, [None] * J
        for j, par in enumerate(PARENTS):
            q = tuple(local[(f * J + j) * 4:(f * J + j) * 4 + 4])
            if par < 0:
                g[j], p[j] = q, tuple(roots[f * 3:f * 3 + 3])
            else:
                g[j] = qmul(g[par], q)
                d = qrot(g[par], OFFSETS[j])
                p[j] = (p[par][0] + d[0], p[par][1] + d[1], p[par][2] + d[2])
        for j in range(J):
            rots.extend(g[j]); pos.extend(p[j])
    return frames, rots, pos


class Worker:
    def __init__(self, exe, motion, text):
        env = dict(os.environ, KIMODO_BACKEND=os.environ.get("KIMODO_BACKEND", "cpu"))
        self.proc = subprocess.Popen([exe, "--server", motion, text], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=env)
        self.lock = threading.Lock()

    def generate(self, prompt, frames, steps, seed):
        with self.lock, tempfile.TemporaryDirectory() as tmp:
            # Single segment: the transition length (required 1..60 by kmd-generate) has no effect.
            prompt_path = os.path.join(tmp, "prompt.txt")
            with open(prompt_path, "w", encoding="utf-8") as f:
                f.write(prompt)
            out = os.path.join(tmp, "out")
            self.proc.stdin.write("\t".join(map(str, [1, steps, seed, out, frames, prompt_path])) + "\n")
            self.proc.stdin.flush()
            line = self.proc.stdout.readline().strip()
            if not line.startswith("OK"):
                raise RuntimeError(line or "kmd-generate worker stopped")
            return read_f32(os.path.join(out, "local_rotations_xyzw.f32")), read_f32(os.path.join(out, "root_positions.f32"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--steps", type=int, default=100)
    ap.add_argument("--allow-origin", default="http://localhost:5173")
    args = ap.parse_args()
    motion = os.environ["KIMODO_MOTION"]
    worker = Worker(os.environ.get("KMD_GENERATE", "kmd-generate"), motion, os.environ["KIMODO_TEXT"])
    rest = rest_positions()

    class Handler(BaseHTTPRequestHandler):
        def cors(self):
            self.send_header("Access-Control-Allow-Origin", args.allow_origin)
            self.send_header("Access-Control-Allow-Headers", "Content-Type")

        def do_OPTIONS(self):
            self.send_response(204); self.cors(); self.end_headers()

        def do_POST(self):
            if self.path != "/generate":
                self.send_error(404); return
            try:
                req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                prompt = str(req["prompt"])[:500]
                frames = max(30, min(300, round(float(req.get("seconds", 6)) * FPS)))
                seed = int(req.get("seed", 0))
                t0 = time.perf_counter()
                local, roots = worker.generate(prompt, frames, args.steps, seed)
                latency = (time.perf_counter() - t0) * 1000
                n, rots, pos = forward(local, roots)
                body = json.dumps({"model": "nvidia/Kimodo-SOMA-RP-v1.2", "modelRevision": os.path.basename(motion),
                                   "runtime": f"kimodo.cpp kmd-generate ({os.environ.get('KIMODO_BACKEND', 'cpu')})", "fps": FPS,
                                   "jointNames": NAMES, "parents": PARENTS, "restPositions": rest,
                                   "globalRotations": rots, "positions": pos, "seed": seed, "latencyMs": round(latency),
                                   "extra": {"diffusionSteps": args.steps, "frames": n}}).encode()
                self.send_response(200)
            except Exception as e:  # report, never substitute motion
                body = json.dumps({"error": str(e)}).encode()
                self.send_response(500)
            self.cors(); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(body)

    ThreadingHTTPServer((os.environ.get("KIMODO_HOST", "127.0.0.1"), args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
