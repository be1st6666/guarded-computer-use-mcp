/**
 * OCR backends.
 *
 *   windows  — Windows.Media.Ocr through Windows PowerShell 5.1 (.NET Core has
 *              no WinRT projection), zero install, weak on large glyphs
 *   rapidocr — PaddleOCR models on ONNXRuntime (~14 MB) via `uv`, strong on
 *              Chinese; kept warm in a resident worker that exits when idle
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT } from './paths.js';
import { UV_CANDIDATES, childEnv } from './shell.js';

export const OCR_SCRIPT = path.join(ROOT, 'ocr.ps1');
export const RAPID_SCRIPT = path.join(ROOT, 'ocr_rapid.py');

export const OCR_IDLE_MS = Number(process.env.COMPUTER_USE_OCR_IDLE_MS ?? 60000);

/** Collect a helper's stdout and parse its last JSON line. */
export function collectJson(ps, label) {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    ps.stdout.setEncoding('utf8');
    ps.stderr.setEncoding('utf8');
    ps.stdout.on('data', (d) => {
      out += d;
    });
    ps.stderr.on('data', (d) => {
      err += d;
    });
    ps.on('error', reject);
    ps.on('close', (code) => {
      const line = out.trim().split('\n').filter(Boolean).pop() || '';
      if (!line) return reject(new Error(`${label} produced no output (exit ${code}) ${err.slice(0, 300)}`));
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        return reject(new Error(`${label} output not JSON: ${line.slice(0, 200)}`));
      }
      if (parsed.error) return reject(new Error(parsed.error));
      resolve(parsed);
    });
  });
}

export function runWindowsOcr(rectArgs) {
  return collectJson(
    spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', OCR_SCRIPT, ...rectArgs], {
      windowsHide: true,
      env: childEnv(),
    }),
    'windows-ocr',
  );
}

function spawnUv(uv) {
  return new Promise((resolve, reject) => {
    const ps = spawn(uv, ['run', '--no-project', '--with', 'rapidocr-onnxruntime', 'python', RAPID_SCRIPT, '--serve'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: childEnv({ UV_HTTP_TIMEOUT: '180' }),
    });
    let settled = false;
    ps.once('error', (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
    ps.once('spawn', () => {
      if (!settled) {
        settled = true;
        resolve(ps);
      }
    });
  });
}

export class RapidWorker {
  constructor() {
    this.proc = null;
    this.spawnPromise = null;
    this.buf = '';
    this.pending = new Map();
    this.nextId = 1;
    this.idleTimer = null;
  }

  async ensure() {
    if (this.proc && !this.proc.killed) return;
    if (this.spawnPromise) return this.spawnPromise;

    this.spawnPromise = (async () => {
      let lastErr;
      for (const uv of UV_CANDIDATES) {
        try {
          const ps = await spawnUv(uv);
          this.proc = ps;
          process.stderr.write(`[computer-use] ocr worker: ${uv}\n`);
          ps.stdout.setEncoding('utf8');
          ps.stderr.setEncoding('utf8');
          ps.stdout.on('data', (d) => this.#onData(d));
          ps.stderr.on('data', (d) => process.stderr.write('[rapid] ' + d));
          ps.on('exit', () => {
            for (const p of this.pending.values()) p.reject(new Error('ocr worker exited'));
            this.pending.clear();
            this.proc = null;
            this.spawnPromise = null;
          });
          return;
        } catch (e) {
          if (e.code === 'ENOENT') {
            lastErr = e;
            continue;
          }
          this.spawnPromise = null;
          throw e;
        }
      }
      this.spawnPromise = null;
      throw new Error(`uv not found (tried ${UV_CANDIDATES.join(', ')}): ${lastErr?.message}`);
    })();

    await this.spawnPromise;
  }

  #onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(Buffer.from(line, 'base64').toString('utf8'));
      } catch {
        continue;
      }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error));
    }
  }

  /** Reset the idle timer after each use; on expiry, free the ~157 MB. */
  #armIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      process.stderr.write(`[computer-use] ocr worker idle ${OCR_IDLE_MS}ms, releasing memory\n`);
      this.stop();
    }, OCR_IDLE_MS);
    this.idleTimer.unref?.();
  }

  async call(pngPath, ox, oy, timeoutMs = 60000) {
    await this.ensure();
    const id = this.nextId++;
    const payload = Buffer.from(JSON.stringify({ id, png: pngPath, ox, oy }), 'utf8').toString('base64');
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ocr worker timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.proc.stdin.write(payload + '\n');
    });
    this.#armIdleTimer();
    return result;
  }

  stop() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const p = this.proc;
    this.proc = null;
    this.spawnPromise = null;
    if (!p) return;
    try {
      p.stdin.end();
    } catch {
      /* ignore */
    }
    try {
      p.kill();
    } catch {
      /* ignore */
    }
  }
}

export const rapidWorker = new RapidWorker();

export async function runRapidOcr(pngPath, ox, oy) {
  return rapidWorker.call(pngPath, ox, oy);
}
