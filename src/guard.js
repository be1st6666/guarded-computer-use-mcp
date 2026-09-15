/**
 * Guard switches — the marker files that turn a protection layer OFF.
 *
 *   .approval-off   approval dialog disabled
 *   .guard-off      deny lists + rate limit disabled
 *   .audit-off      audit log disabled
 *   .physical-off   approval dialog accepts injected (SendInput) keystrokes
 *
 * Why this is not just "does the file exist":
 *
 * The old rule was `existsSync(flag)`. Anything that can write a file in this
 * directory — including the agent itself, when it also has a file-writing or
 * terminal tool — could therefore turn the guard off with a one-byte `touch`.
 * The README claimed the model could not bypass the guard, which was only true
 * if the model had no filesystem access.
 *
 * Markers are now HMAC-signed with a per-install secret (`guard.key`, or
 * COMPUTER_USE_GUARD_SECRET in the environment of whoever launched the server).
 * An unsigned or tampered marker is **ignored** — fail closed — and recorded as
 * a `guard_tamper` event that is written to the audit log, printed on stderr,
 * and surfaced in the tool result the model sees.
 *
 * Be honest about the limit: a same-user attacker can read guard.key, so this is
 * a speed bump plus a tripwire, not a boundary. Keeping the secret in the
 * launcher's environment (COMPUTER_USE_GUARD_SECRET) is what turns it into a
 * real boundary — an agent that cannot read that environment cannot forge a
 * valid marker.
 *
 * Set COMPUTER_USE_GUARD_ALLOW_PLAIN=1 to get the old "any file counts"
 * behaviour back; tampering is still logged.
 */
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ROOT } from './paths.js';

export const SWITCH_NAMES = ['approval', 'guard', 'audit', 'physical'];

/** Marker file per switch, unchanged from the original layout. */
export const MARKERS = {
  approval: '.approval-off',
  guard: '.guard-off',
  audit: '.audit-off',
  physical: '.physical-off',
};

export const KEY_NAME = 'guard.key';

/** Directory that holds the markers and the signing key. Tests point it at a temp dir. */
let dir = ROOT;
export function guardDir() {
  return dir;
}
export function configure({ dir: d } = {}) {
  if (d) {
    dir = path.resolve(d);
    cachedSecret = null;
    tamperEvents.length = 0;
    reported.clear();
  }
  return dir;
}
export const keyPath = () => path.join(dir, KEY_NAME);

/* --------------------------------------------------- accepted-marker state */

const STATE_NAME = 'guard.state.json';
const statePath = () => path.join(dir, STATE_NAME);

function readState() {
  try {
    const s = JSON.parse(readFileSync(statePath(), 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}

function writeState(state) {
  try {
    writeFileSync(statePath(), JSON.stringify(state, null, 2) + '\n');
  } catch {
    /* best effort: never break a tool call over the watermark */
  }
}

const allowPlain = () => process.env.COMPUTER_USE_GUARD_ALLOW_PLAIN === '1';

export function markerPath(name) {
  if (!MARKERS[name]) throw new Error(`unknown guard switch: ${name}`);
  return path.join(dir, MARKERS[name]);
}

/* --------------------------------------------------------------- secret */

let cachedSecret = null;
let secretWarning = null;

/**
 * The signing secret. Environment wins so an operator can withhold it from the
 * agent's filesystem entirely; otherwise it is created once next to the code.
 */
export function guardSecret() {
  if (cachedSecret) return cachedSecret;
  const fromEnv = process.env.COMPUTER_USE_GUARD_SECRET;
  if (fromEnv && fromEnv.trim()) {
    cachedSecret = Buffer.from(fromEnv.trim(), 'utf8');
    return cachedSecret;
  }
  try {
    const kp = keyPath();
    if (existsSync(kp)) {
      const v = readFileSync(kp, 'utf8').trim();
      if (v) {
        cachedSecret = Buffer.from(v, 'utf8');
        return cachedSecret;
      }
    }
    const hex = randomBytes(32).toString('hex');
    writeFileSync(kp, hex + '\n', { mode: 0o600 });
    cachedSecret = Buffer.from(hex, 'utf8');
    return cachedSecret;
  } catch (e) {
    // Read-only install with no env secret: nothing can be signed, so every
    // marker fails closed. Say so instead of silently trusting files.
    secretWarning = `cannot read or create ${keyPath()}: ${e.message}`;
    cachedSecret = Buffer.from(randomBytes(32).toString('hex'), 'utf8');
    return cachedSecret;
  }
}

/**
 * Signature over the marker's whole meaning: version, switch, state, timestamp
 * and a per-switch counter.
 *
 * The counter is what makes a marker unreplayable: a captured marker carries a
 * valid signature forever, so without a monotonic value anyone who can write
 * files (but not read the key) could restore an old, legitimately signed marker
 * and turn a layer back off. Timestamps alone are not enough — two toggles can
 * land in the same millisecond.
 */
function sign(name, off, at, n) {
  return createHmac('sha256', guardSecret()).update(`v1|${name}|${off}|${at}|${n}`).digest('hex');
}

/* ---------------------------------------------------- tamper bookkeeping */

const tamperEvents = [];
const reported = new Set();

function noteTamper(name, reason, detail) {
  const key = `${name}|${reason}`;
  if (!reported.has(key)) {
    reported.add(key);
    tamperEvents.push({ name, reason, detail, at: new Date().toISOString() });
    process.stderr.write(`[computer-use] GUARD TAMPER: ${MARKERS[name]} ${reason} — ignored (fails closed)\n`);
  }
}

/** All tamper events seen so far (newest last). */
export function tamperEvents_() {
  return tamperEvents.slice();
}

/** One-line warning to prepend to tool results, or null. */
export function tamperWarning() {
  if (!tamperEvents.length) return null;
  const names = [...new Set(tamperEvents.map((e) => e.name))].join(', ');
  return (
    `WARNING: ${tamperEvents.length} guard marker(s) failed signature verification (${names}). ` +
    'The protection layers stay ON; the marker was ignored. See audit.jsonl (op=guard_tamper).'
  );
}

export function _resetTamperState() {
  tamperEvents.length = 0;
  reported.clear();
}

/* ------------------------------------------------------------- reading */

/**
 * Inspect one marker without trusting it.
 * @returns {{name:string, path:string, exists:boolean, off:boolean, signed:boolean,
 *            tampered:boolean, at:string|null, reason:string|null}}
 */
export function readSwitch(name) {
  const p = markerPath(name);
  const base = { name, path: p, exists: false, off: false, signed: false, tampered: false, at: null, reason: null };
  if (!existsSync(p)) {
    // Note the switch going away: a marker that reappears afterwards with a
    // counter we have already accepted is a replay, not the same live marker.
    const st = readState();
    if (st[name] && st[name].live === true) {
      st[name] = { ...st[name], live: false };
      writeState(st);
    }
    return base;
  }

  let raw;
  try {
    raw = readFileSync(p, 'utf8');
  } catch (e) {
    noteTamper(name, `unreadable (${e.message})`, null);
    return { ...base, exists: true, tampered: true, reason: 'unreadable' };
  }

  let doc = null;
  try {
    doc = JSON.parse(raw);
  } catch {
    /* not JSON */
  }

  if (
    !doc ||
    typeof doc !== 'object' ||
    doc.v !== 1 ||
    doc.switch !== name ||
    typeof doc.at !== 'string' ||
    typeof doc.n !== 'number'
  ) {
    const why = 'not a signed guard-panel marker';
    if (allowPlain()) {
      noteTamper(name, `${why} (honoured: COMPUTER_USE_GUARD_ALLOW_PLAIN=1)`, raw.slice(0, 120));
      return { ...base, exists: true, off: true, tampered: true, reason: 'unsigned (allowed by env)' };
    }
    noteTamper(name, why, raw.slice(0, 120));
    return { ...base, exists: true, tampered: true, reason: why };
  }

  const expect = sign(name, doc.off === true, doc.at, doc.n);
  const got = typeof doc.sig === 'string' ? doc.sig : '';
  let ok;
  try {
    ok = got.length === expect.length && timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(expect, 'hex'));
  } catch {
    ok = false;
  }

  if (!ok) {
    const why = 'signature mismatch (hand-edited or forged)';
    if (allowPlain()) {
      noteTamper(name, `${why} (honoured: COMPUTER_USE_GUARD_ALLOW_PLAIN=1)`, null);
      return { ...base, exists: true, off: doc.off === true, tampered: true, reason: 'bad signature (allowed by env)' };
    }
    noteTamper(name, why, null);
    return { ...base, exists: true, tampered: true, reason: why };
  }

  // Replay check: a captured marker carries a valid signature forever, so the
  // watermark (highest counter accepted, plus the signature that carried it) is
  // what makes restoring an old one detectable and refused. Re-reading the marker
  // that is still in place is fine; the same counter turning up after the switch
  // was cleared is not. An attacker who can also roll the watermark back defeats
  // this — it raises the bar rather than being a boundary.
  const state = readState();
  const seen = state[name] && typeof state[name] === 'object' ? state[name] : {};
  const seenN = typeof seen.n === 'number' ? seen.n : 0;
  const stillLive = seen.live === true && doc.n === seenN && doc.sig === seen.sig;
  if (doc.n < seenN || (doc.n === seenN && !stillLive)) {
    const why = `replayed marker (counter ${doc.n}; the accepted state is ${seenN}${seen.live === false ? ', and the switch was cleared since' : ''})`;
    if (allowPlain()) {
      noteTamper(name, `${why} (honoured: COMPUTER_USE_GUARD_ALLOW_PLAIN=1)`, null);
      return { ...base, exists: true, off: doc.off === true, tampered: true, reason: 'replay (allowed by env)' };
    }
    noteTamper(name, why, null);
    return { ...base, exists: true, tampered: true, reason: why };
  }
  state[name] = { n: doc.n, at: doc.at, sig: doc.sig, live: true };
  writeState(state);

  return { ...base, exists: true, off: doc.off === true, signed: true, at: doc.at, reason: null };
}

/** True when the switch is OFF — i.e. that protection layer is disabled. */
export function isOff(name) {
  return readSwitch(name).off === true;
}

/** Snapshot of every switch, used by the startup audit record and the panel. */
export function switchState() {
  const out = {};
  for (const n of SWITCH_NAMES) {
    const s = readSwitch(n);
    out[n] = s.tampered ? 'tampered' : s.off ? 'off' : 'on';
  }
  return out;
}

/* ------------------------------------------------------------- writing */

/**
 * Turn a switch on/off with a valid signature. Used by the panel and by tests;
 * never callable from an MCP tool.
 * @returns {{ok:boolean, name:string, off:boolean, path:string, error?:string}}
 */
export function setSwitch(name, off) {
  const p = markerPath(name);
  try {
    if (!off) {
      if (existsSync(p)) unlinkSync(p);
      const st = readState();
      if (st[name]) {
        st[name] = { ...st[name], live: false };
        writeState(st);
      }
      return { ok: true, name, off: false, path: p };
    }
    const state = readState();
    const n = ((state[name] && typeof state[name].n === 'number' ? state[name].n : 0) || 0) + 1;
    const at = new Date().toISOString();
    const doc = { v: 1, switch: name, off: true, at, n, by: 'guard-panel', sig: sign(name, true, at, n) };
    writeFileSync(p, JSON.stringify(doc, null, 2) + '\n');
    return { ok: true, name, off: true, path: p };
  } catch (e) {
    return { ok: false, name, off, path: p, error: e.message };
  }
}

export function removeAllMarkers() {
  for (const n of SWITCH_NAMES) {
    const p = markerPath(n);
    try {
      if (existsSync(p)) rmSync(p);
    } catch {
      /* ignore */
    }
  }
}

export function secretStatus() {
  return {
    source: process.env.COMPUTER_USE_GUARD_SECRET ? 'environment' : existsSync(keyPath()) ? 'guard.key' : 'none',
    keyPath: keyPath(),
    /**
     * Fingerprint of the key actually in use. The audit log records this at
     * startup, so swapping guard.key for one the attacker knows is visible from
     * one run to the next.
     */
    fingerprint: createHash('sha256').update(guardSecret()).digest('hex').slice(0, 12),
    warning: secretWarning,
    allowPlain: allowPlain(),
  };
}

/* ------------------------------------------------------------------ CLI */

function cli(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'list') {
    const state = Object.fromEntries(SWITCH_NAMES.map((n) => [n, readSwitch(n)]));
    if (rest.includes('--json')) process.stdout.write(JSON.stringify(state, null, 2) + '\n');
    else
      for (const n of SWITCH_NAMES) {
        const s = state[n];
        process.stdout.write(
          `${n.padEnd(9)} ${s.tampered ? 'TAMPERED' : s.off ? 'off' : 'on'}` + `${s.at ? `  (since ${s.at})` : ''}\n`,
        );
      }
    return 0;
  }
  if (cmd === 'set') {
    const [name, value] = rest;
    if (!SWITCH_NAMES.includes(name) || !['on', 'off'].includes(value)) {
      process.stderr.write(`usage: node src/guard.js set <${SWITCH_NAMES.join('|')}> <on|off>\n`);
      return 2;
    }
    const r = setSwitch(name, value === 'off');
    if (!r.ok) {
      process.stderr.write(`failed: ${r.error}\n`);
      return 1;
    }
    process.stdout.write(`${name} ${value}\n`);
    return 0;
  }
  if (cmd === 'verify') {
    let bad = 0;
    for (const n of SWITCH_NAMES) {
      const s = readSwitch(n);
      process.stdout.write(
        `${n.padEnd(9)} ${s.exists ? (s.tampered ? `TAMPERED (${s.reason})` : `signed, off=${s.off}`) : 'absent (on)'}\n`,
      );
      if (s.tampered) bad++;
    }
    return bad ? 1 : 0;
  }
  process.stderr.write('usage: node src/guard.js <list [--json] | set <switch> <on|off> | verify>\n');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = cli(process.argv.slice(2));
}
