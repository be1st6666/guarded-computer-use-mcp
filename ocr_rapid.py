"""
RapidOCR backend for computer-use-mcp.

RapidOCR runs PaddleOCR's detection/recognition models on ONNXRuntime, so it
gets close to PaddleOCR accuracy at ~14 MB instead of a 500 MB paddle
runtime, and needs neither a GPU nor torch.

Two modes:

  one-shot (default) - spawn, OCR one image, exit. Peak RSS ~157 MB, paid and
  freed every call.
      uv run --no-project --with rapidocr-onnxruntime python ocr_rapid.py <png> [ox] [oy]

  --serve - stay alive and answer requests on stdin, so the ~500 ms model
  initialisation is paid once instead of per call. server.js keeps this
  process warm and kills it after an idle period, so the memory is only held
  while OCR is actually in use.
      one base64(UTF-8 JSON) request per line, one base64(UTF-8 JSON) reply:
        {"id":1,"png":"C:/...png","ox":0,"oy":0}
      -> {"id":1,"ok":true,"result":{...}}  |  {"id":1,"ok":false,"error":"..."}

Both modes print a single compact JSON line (serve mode: base64 of it).
"""
import base64
import json
import sys
import time


def _recognise(engine, png_path: str, ox: int, oy: int) -> dict:
    t0 = time.perf_counter()
    result, _elapse = engine(png_path)
    t_ocr = time.perf_counter() - t0

    words = []
    for item in (result or []):
        box, text, score = item[0], item[1], item[2]
        xs = [float(p[0]) for p in box]
        ys = [float(p[1]) for p in box]
        x0, y0 = int(min(xs)), int(min(ys))
        words.append({
            "t": text,
            "box": [ox + x0, oy + y0, int(max(xs) - x0), int(max(ys) - y0)],
            "score": round(float(score), 3),
        })
    return {
        "text": " ".join(w["t"] for w in words),
        "words": words,
        "ms": {"ocr": round(t_ocr * 1000, 1)},
    }


def _load_engine():
    t0 = time.perf_counter()
    from rapidocr_onnxruntime import RapidOCR
    engine = RapidOCR()
    return engine, round((time.perf_counter() - t0) * 1000, 1)


def run_once(argv) -> int:
    if len(argv) < 1:
        print(json.dumps({"error": "usage: ocr_rapid.py <png> [ox] [oy]"}))
        return 1
    engine, t_init = _load_engine()
    try:
        out = _recognise(engine, argv[0], int(argv[1]) if len(argv) > 1 else 0,
                         int(argv[2]) if len(argv) > 2 else 0)
    except Exception as exc:  # noqa: BLE001 - surfaced to the caller as JSON
        print(json.dumps({"error": str(exc)}))
        return 1
    out["ms"]["init"] = t_init
    print(json.dumps(out, ensure_ascii=True))
    return 0


def serve() -> int:
    engine, t_init = _load_engine()
    sys.stderr.write("rapidocr ready in %sms\n" % t_init)
    sys.stderr.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(base64.b64decode(line).decode("utf-8"))
        except Exception:  # noqa: BLE001 - ignore malformed lines
            continue
        rid = req.get("id", -1)
        if req.get("op") == "shutdown":
            reply = {"id": rid, "ok": True, "result": {"bye": True}}
        else:
            try:
                res = _recognise(engine, req["png"], int(req.get("ox", 0)), int(req.get("oy", 0)))
                res["ms"]["init"] = 0.0
                reply = {"id": rid, "ok": True, "result": res}
            except Exception as exc:  # noqa: BLE001
                reply = {"id": rid, "ok": False, "error": str(exc)}
        blob = base64.b64encode(json.dumps(reply, ensure_ascii=True).encode("utf-8")).decode("ascii")
        sys.stdout.write(blob + "\n")
        sys.stdout.flush()
        if req.get("op") == "shutdown":
            break
    return 0


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == "--serve":
        return serve()
    return run_once(sys.argv[1:])


if __name__ == "__main__":
    sys.exit(main())
