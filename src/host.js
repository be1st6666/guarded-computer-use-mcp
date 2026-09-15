/**
 * Resident PowerShell host.
 *
 * One long-lived shell process holds the compiled C# helper (Add-Type costs
 * 300-500 ms; a resident host turns a call into 1-12 ms). Requests and replies
 * are one base64(UTF-8 JSON) line each way, which keeps every byte on the wire
 * ASCII and sidesteps Windows PowerShell 5.1 console-encoding entirely.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT } from './paths.js';
import { SHELL_CANDIDATES } from './shell.js';

export const HOST_SCRIPT = path.join(ROOT, 'host.ps1');

function spawnCandidate(cmd) {
  return new Promise((resolve, reject) => {
    const ps = spawn(
      cmd,
      ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HOST_SCRIPT],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
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

export class PsHost {
  constructor() {
    this.proc = null;
    this.spawnPromise = null;
    this.buf = '';
    this.pending = new Map();
    this.nextId = 1;
    this.shell = null;
  }

  async ensure() {
    if (this.proc && !this.proc.killed) return;
    if (this.spawnPromise) return this.spawnPromise;

    this.spawnPromise = (async () => {
      let lastErr;
      for (const cmd of SHELL_CANDIDATES) {
        try {
          const ps = await spawnCandidate(cmd);
          this.proc = ps;
          this.shell = cmd;
          process.stderr.write(`[computer-use] host shell: ${cmd}\n`);
          ps.stdout.setEncoding('utf8');
          ps.stderr.setEncoding('utf8');
          ps.stdout.on('data', (d) => this.#onData(d));
          ps.stderr.on('data', (d) => process.stderr.write('[host] ' + d));
          ps.on('exit', (code) => {
            for (const p of this.pending.values()) p.reject(new Error(`shell host exited (code ${code})`));
            this.pending.clear();
            this.proc = null;
            this.spawnPromise = null;
          });
          return;
        } catch (e) {
          lastErr = e;
        }
      }
      this.spawnPromise = null;
      throw new Error(`no usable shell found (tried ${SHELL_CANDIDATES.join(', ')}): ${lastErr?.message}`);
    })();

    await this.spawnPromise;
    // The first ping pays the C# compile cost.
    await this.raw('ping', {}, 90000);
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

  raw(op, args = {}, timeoutMs = 30000) {
    const id = this.nextId++;
    const payload = Buffer.from(JSON.stringify({ id, op, args }), 'utf8').toString('base64');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`host timeout after ${timeoutMs}ms (op=${op})`));
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
  }

  async call(op, args = {}, timeoutMs = 30000) {
    await this.ensure();
    return this.raw(op, args, timeoutMs);
  }

  dispose() {
    try {
      this.raw('shutdown', {}, 2000).catch(() => {});
    } catch {
      /* ignore */
    }
  }
}

export const host = new PsHost();
