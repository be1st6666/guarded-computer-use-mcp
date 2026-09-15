#!/usr/bin/env node
/**
 * Dependency-free MCP stdio smoke test.
 *
 * Spawns `node server.js`, speaks newline-delimited JSON-RPC on stdin/stdout and asserts that
 * the server handshakes and advertises the expected tool surface.
 *
 * It NEVER calls a tool (only `initialize` + `tools/list`), so it is safe on a headless CI
 * runner. The server does write its own audit log / guard.key as a startup side effect; that is
 * expected and harmless.
 *
 * Usage: node test/smoke.mjs   (or: npm run test:smoke)
 * Exits 0 when every check passes, 1 otherwise.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SERVER = path.join(ROOT, 'server.js');
const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const WATCHDOG_MS = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;
const EXPECTED_NAME = 'guarded-computer-use-mcp';
const MIN_TOOL_COUNT = 26;
const REQUIRED_TOOLS = [
  'screenshot',
  'zoom',
  'screen_hash',
  'wait_for_change',
  'batch',
  'ocr',
  'find_elements',
  'click_element',
  'ui_tree',
  'launch_app',
  'clipboard_read',
  'clipboard_write',
  'wait',
  'bench',
  'cursor_position',
  'list_displays',
  'list_windows',
  'active_window',
  'mouse_move',
  'click',
  'drag',
  'scroll',
  'type_text',
  'key',
  'hold_key',
  'activate_window',
];

/* --------------------------------------------------------------- reporting */

let passed = 0;
const failures = [];

function pass(label) {
  passed += 1;
  console.log(`PASS  ${label}`);
}

function fail(label, detail) {
  failures.push(label);
  console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
}

function check(ok, label, detail) {
  if (ok) pass(label);
  else fail(label, detail);
  return ok;
}

/* ------------------------------------------------------------ stdio client */

const child = spawn(process.execPath, [SERVER], {
  cwd: ROOT,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  env: { ...process.env, CI: process.env.CI ?? '1' },
});

let buffer = '';
let nextId = 1;
let stderrTail = '';
const pending = new Map();

const watchdog = setTimeout(() => {
  console.log(`FAIL  watchdog — no result within ${WATCHDOG_MS}ms`);
  cleanup(1);
}, WATCHDOG_MS);
watchdog.unref?.();

function cleanup(code) {
  clearTimeout(watchdog);
  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending.clear();
  if (child && child.exitCode === null && child.signalCode === null) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
  process.exit(code);
}

function onLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    // Servers sometimes emit non-JSON chatter on stdout; ignore it rather than crash.
    return;
  }
  if (msg.id === undefined || msg.id === null) return; // notification
  const entry = pending.get(msg.id);
  if (!entry) return;
  pending.delete(msg.id);
  clearTimeout(entry.timer);
  entry.resolve(msg);
}

function request(method, params) {
  const id = nextId++;
  const payload = { jsonrpc: '2.0', id, method };
  if (params !== undefined) payload.params = params;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for "${method}" response`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    child.stdin.write(`${JSON.stringify(payload)}\n`, (err) => {
      if (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      }
    });
  });
}

function notify(method, params) {
  const payload = { jsonrpc: '2.0', method };
  if (params !== undefined) payload.params = params;
  child.stdin.write(`${JSON.stringify(payload)}\n`);
}

function unwrap(msg, method) {
  if (!msg) throw new Error(`no response to "${method}"`);
  if (msg.error) throw new Error(`"${method}" returned JSON-RPC error ${msg.error.code}: ${msg.error.message}`);
  if (!msg.result) throw new Error(`"${method}" returned no result`);
  return msg.result;
}

/* -------------------------------------------------------------------- main */

console.log(`smoke: spawning ${path.relative(ROOT, SERVER)} (node ${process.version})`);

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    onLine(line);
  }
});

child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  stderrTail = (stderrTail + chunk).slice(-4000);
});

child.on('error', (err) => {
  fail('spawn server.js', err.message);
  cleanup(1);
});

child.on('exit', (code, signal) => {
  if (pending.size > 0) {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`server exited (code=${code} signal=${signal}) before answering id ${id}`));
    }
    pending.clear();
  }
});

function diagnostics() {
  return stderrTail.trim().split('\n').slice(-5).join(' | ');
}

try {
  /* --- initialize ------------------------------------------------------ */
  const init = unwrap(
    await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke', version: PKG.version },
    }),
    'initialize',
  );

  check(
    typeof init.protocolVersion === 'string' && init.protocolVersion.length > 0,
    'initialize returns protocolVersion',
    `got ${JSON.stringify(init.protocolVersion)}`,
  );

  const info = init.serverInfo ?? {};
  check(info.name === EXPECTED_NAME, `serverInfo.name === "${EXPECTED_NAME}"`, `got ${JSON.stringify(info.name)}`);
  check(info.version === PKG.version, `serverInfo.version === package.json version (${PKG.version})`, `got ${JSON.stringify(info.version)}`);

  /* --- initialized notification --------------------------------------- */
  notify('notifications/initialized');
  pass('sent notifications/initialized (no id, no response expected)');

  /* --- tools/list ------------------------------------------------------ */
  const listed = unwrap(await request('tools/list', {}), 'tools/list');
  const tools = Array.isArray(listed.tools) ? listed.tools : [];
  check(
    tools.length >= MIN_TOOL_COUNT,
    `tools/list returns >= ${MIN_TOOL_COUNT} tools`,
    `got ${tools.length}`,
  );

  const names = new Set(tools.map((t) => t?.name));
  const missing = REQUIRED_TOOLS.filter((n) => !names.has(n));
  check(missing.length === 0, `tools/list includes all ${REQUIRED_TOOLS.length} required tools`, `missing: ${missing.join(', ')}`);

  const noDescription = tools.filter((t) => typeof t?.description !== 'string' || t.description.trim() === '');
  check(
    noDescription.length === 0,
    'every tool has a non-empty description',
    `offenders: ${noDescription.map((t) => t?.name).join(', ')}`,
  );

  const badSchema = tools.filter((t) => !t?.inputSchema || t.inputSchema.type !== 'object');
  check(
    badSchema.length === 0,
    'every tool has an inputSchema with type "object"',
    `offenders: ${badSchema.map((t) => t?.name).join(', ')}`,
  );

  console.log(`smoke: saw ${tools.length} tools`);
} catch (err) {
  const detail = diagnostics();
  fail(`handshake (${err.message})`, detail || undefined);
}

if (failures.length > 0) {
  console.log(`\nsmoke: FAILED (${failures.length} of ${passed + failures.length} checks)`);
  cleanup(1);
}
console.log(`\nsmoke: PASSED (${passed} checks)`);
cleanup(0);
