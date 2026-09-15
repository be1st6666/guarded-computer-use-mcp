/**
 * Protocol-level regression test for the parallel-tool-call approval bypass.
 *
 * The claim under test: tool handlers in `server.js` are async, so a real MCP
 * client can have two tool calls in flight at once. Before the fix, the second
 * one — `key("alt+a")` or a click on Allow — could answer the dialog that the
 * first one had opened, i.e. the model approved its own destructive action.
 *
 * This drives the real server over stdio JSON-RPC:
 *   1. spawn server.js with a policy whose approval list matches the current
 *      foreground window, so any mutating tool needs approval
 *   2. call `type_text` and leave the call in flight (the dialog appears)
 *   3. while it is in flight, call `key("alt+a")` and `click`
 *   4. both must be refused with `refused_by_approval_gate`, and must return
 *      BEFORE the first call resolves
 *   5. the first call must end as `denied_by_approval` (timeout -> auto-deny)
 *
 * Needs an interactive desktop (it shows the real dialog for ~8 s), so it is not
 * part of CI.   `npm run test:lock`
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ROOT } from '../src/paths.js';
import { host } from '../src/host.js';

const TIMEOUT_MS = 8000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.env.CI === '1' || process.env.CI === 'true') {
  console.log('SKIP gate-lock-e2e: needs an interactive desktop (CI=1)');
  process.exit(0);
}

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`);
  if (!ok) failures++;
};

/* The policy has to make the *current* foreground window an always-ask target,
   otherwise nothing pops the dialog. Process name is the reliable part. */
const fg = await host.call('active_window', {});
const fgProcess = String(fg?.process ?? '').toLowerCase();
const fgTitle = String(fg?.title ?? '');
if (!fgProcess) {
  console.log('SKIP gate-lock-e2e: no foreground window to target');
  host.dispose();
  process.exit(0);
}
console.log(`foreground: ${fgProcess} | ${fgTitle}`);

const dir = mkdtempSync(path.join(tmpdir(), 'gate-lock-'));
const policyPath = path.join(dir, 'policy.json');
const auditPath = path.join(dir, 'audit.jsonl');
writeFileSync(policyPath, JSON.stringify({
  approval_processes: [fgProcess],
  approval: { enabled: true, timeout_ms: TIMEOUT_MS, require_physical_input: true },
  max_actions_per_minute: 600,
}, null, 2));

const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    COMPUTER_USE_POLICY: policyPath,
    COMPUTER_USE_AUDIT: auditPath,
    COMPUTER_USE_OCR_IDLE_MS: '1000',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
const pending = new Map();
let nextId = 1;
child.stdout.setEncoding('utf8');
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const p = pending.get(msg.id);
    if (!p) continue;
    pending.delete(msg.id);
    p(msg);
  }
});
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => { stderr += d; });

function send(method, params, { id = nextId++ } = {}) {
  const msg = { jsonrpc: '2.0', method, params };
  if (id !== null) msg.id = id;
  child.stdin.write(JSON.stringify(msg) + '\n');
  if (id === null) return Promise.resolve(null);
  return new Promise((resolve) => pending.set(id, resolve));
}

const callTool = (name, args) => send('tools/call', { name, arguments: args });
const payloadOf = (res) => {
  try { return JSON.parse(res?.result?.content?.[0]?.text ?? '{}'); } catch { return {}; }
};

try {
  await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'gate-lock-test', version: '0' },
  });
  await send('notifications/initialized', {}, { id: null });

  // 1. Start an action that needs approval and leave it in flight.
  const first = callTool('type_text', { text: 'gate lock test' });
  await sleep(2500);                       // let the dialog come up

  // 2. Answer it from "the model" while it is still waiting.
  const started = Date.now();
  const [keyRes, clickRes, batchRes] = await Promise.all([
    callTool('key', { combo: 'alt+a' }),
    callTool('click', { x: 10, y: 10 }),
    // `batch` is the one path that calls the tool handlers directly instead of
    // going through the checked wrapper, so it gets its own attempt: the wrapper
    // refuses the batch, and the step loop re-checks the lock after every await.
    callTool('batch', { steps: [{ op: 'click', args: { x: 10, y: 10 } }, { op: 'screenshot', args: {} }] }),
  ]);
  const elapsed = Date.now() - started;

  const keyPayload = payloadOf(keyRes);
  const clickPayload = payloadOf(clickRes);
  check(keyPayload.refused_by_approval_gate === true,
    'key("alt+a") is refused while the dialog waits', JSON.stringify(keyPayload).slice(0, 120));
  check(clickPayload.refused_by_approval_gate === true,
    'click is refused while the dialog waits', JSON.stringify(clickPayload).slice(0, 120));
  const batchText = (batchRes?.result?.content ?? []).map((c) => c.text ?? '').join('\n');
  const batchPayload = payloadOf(batchRes);
  check(
    batchPayload.refused_by_approval_gate === true || /BLOCKED — an approval dialog/.test(batchText),
    'batch is refused while the dialog waits',
    (batchPayload.refused_by_approval_gate ? 'refused by the wrapper' : batchText.split('\n')[0]).slice(0, 120),
  );
  check(elapsed < TIMEOUT_MS,
    'all three refusals came back before the dialog could time out', `${elapsed} ms`);
  check(/injected-input=on/.test(stderr),
    'the dialog really opened with its physical-input filter', (stderr.match(/injected-input=(\w+)/) || [])[1] ?? 'no status line');

  // 3. The first call must end as an auto-denied approval, never as an allow.
  const firstRes = await first;
  const firstPayload = payloadOf(firstRes);
  check(firstPayload.denied_by_approval === true,
    'the original action ended denied_by_approval', JSON.stringify(firstPayload).slice(0, 160));
  check(firstPayload.outcome === 'timed out (auto-denied)',
    'and specifically by timeout, not by an approval', String(firstPayload.outcome));

  // 4. The audit log records the refusal, the denial and the session record.
  const ops = existsSync(auditPath)
    ? readFileSync(auditPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).op)
    : [];
  check(ops.includes('session_start'), 'audit has a session_start record');
  check(ops.includes('type_text'), 'audit recorded the denied type_text');
  check(ops.filter((o) => o === 'key').length >= 1, 'audit recorded the refused key call');
} finally {
  child.kill();
  host.dispose();
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
