/**
 * Audit log — every action, with a hash chain and redaction.
 *
 * Three problems with the original "appendFileSync(JSON.stringify(args))":
 *
 *   1. `type_text` and `clipboard_write` wrote their payload verbatim, so a
 *      typed password ended up in plain text in audit.jsonl. Now values whose
 *      key looks sensitive are replaced by {redacted, chars, sha256[:12]} —
 *      enough to correlate, not enough to leak. Window titles are the one free
 *      text that survives, because "which window" is the whole point of the
 *      log: they are truncated to 80 characters, and
 *      `audit: { redact_titles: true }` (or COMPUTER_USE_AUDIT_REDACT_TITLES=1)
 *      replaces them with a fingerprint too.
 *   2. The log was trivially editable after the fact. Each record now carries
 *      `prev` (the previous record's hash) and `hash` (sha256 over prev + the
 *      canonical payload), so editing, deleting or reordering a line is
 *      detectable: `npm run audit:verify`.
 *   3. It grew without bound. The file rotates at a size cap; rotated segments
 *      are named audit-<timestamp>.jsonl and each segment starts its own chain.
 *
 * The chain is tamper-EVIDENT, not tamper-PROOF: an attacker who can write the
 * file can rewrite the whole chain. It stops quiet edits, which is the
 * realistic failure mode, and it is honest about the rest.
 */
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  statSync,
  readdirSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ROOT } from './paths.js';

export const GENESIS = 'genesis';

/** Argument keys whose values are replaced before they reach the log. */
export const DEFAULT_REDACT_KEYS = [
  'text',
  'password',
  'passwd',
  'pass',
  'secret',
  'token',
  'apikey',
  'api_key',
  'credential',
  'credentials',
  'authorization',
  'cookie',
  'otp',
  'pin',
];

const cfg = {
  file: process.env.COMPUTER_USE_AUDIT ?? path.join(ROOT, 'audit.jsonl'),
  enabled: () => true,
  redact: true,
  redactKeys: DEFAULT_REDACT_KEYS,
  /** Rotate once a segment passes this size. 0 disables rotation. */
  maxBytes: Number(process.env.COMPUTER_USE_AUDIT_MAX_BYTES ?? 16 * 1024 * 1024),
  /** Replace the target window title with a fingerprint instead of keeping it. */
  redactTitles: process.env.COMPUTER_USE_AUDIT_REDACT_TITLES === '1',
  alsoStderr: process.env.COMPUTER_USE_AUDIT_STDERR === '1',
};

/** Window titles kept verbatim are capped at this length. */
export const TITLE_MAX = 80;

/**
 * Point the audit log somewhere else / change its behaviour.
 * Tests use this; the server calls it once at startup.
 */
export function configure(options = {}) {
  Object.assign(cfg, options);
  chain.loaded = false;
  chain.seq = 0;
  chain.hash = GENESIS;
  chain.broke = false;
  chain.legacy = false;
  return { ...cfg, redactKeys: [...cfg.redactKeys] };
}

export function auditConfig() {
  return { ...cfg, redactKeys: [...cfg.redactKeys] };
}

/* ---------------------------------------------------------------- redaction */

const digest12 = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 12);

/**
 * Deep-copy `args`, replacing sensitive leaf values. Recurses into arrays and
 * objects, so `batch` steps (`steps[].args.text`) are covered too.
 */
export function redactArgs(args, extraKeys = []) {
  const keys = new Set([...cfg.redactKeys, ...extraKeys].map((k) => String(k).toLowerCase()));
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        out[k] = keys.has(k.toLowerCase()) ? redactScalar(val) : walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(args ?? {});
}

export function redactScalar(v) {
  if (v === null || v === undefined) return v;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return { redacted: true, chars: s.length, sha256: digest12(s) };
}

/* -------------------------------------------------------------- hash chain */

const chain = { loaded: false, seq: 0, hash: GENESIS, broke: false, legacy: false };

/** Read the last `bytes` of a file without slurping the whole thing. */
function readTail(file, bytes = 8192) {
  const fd = openSync(file, 'r');
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function ensureChain() {
  if (chain.loaded) return chain;
  chain.loaded = true;
  if (!existsSync(cfg.file)) return chain;
  try {
    const lines = readTail(cfg.file)
      .split('\n')
      .filter((l) => l.trim());
    const last = lines[lines.length - 1];
    if (!last) return chain;
    const doc = JSON.parse(last);
    if (typeof doc.hash === 'string' && doc.hash.length === 64 && typeof doc.seq === 'number') {
      chain.seq = doc.seq;
      chain.hash = doc.hash;
    } else if (typeof doc.op === 'string') {
      // A record from before hash chaining existed: readable, just not linked.
      chain.legacy = true;
    } else {
      chain.broke = true;
    }
  } catch {
    chain.broke = true;
  }
  return chain;
}

/** Fixed field order — the canonical form is what gets hashed. */
function payloadOf(doc) {
  return {
    seq: doc.seq,
    t: doc.t,
    op: doc.op,
    args: doc.args ?? {},
    target: doc.target ?? null,
    // Keep the literal value: `ok: 0` hashed as `false` would let a tamperer
    // flip a type without changing the hash.
    ok: doc.ok === undefined ? null : doc.ok,
    note: doc.note ?? null,
  };
}

/**
 * Window titles are the only free text the log keeps. Cap their length, and
 * fingerprint them when the policy asks for it.
 */
function normalizeTarget(target) {
  if (!target) return null;
  const title = target.title ? String(target.title) : '';
  return {
    process: target.process ? String(target.process) : null,
    title: title ? (cfg.redactTitles ? redactScalar(title) : title.slice(0, TITLE_MAX)) : null,
  };
}

function hashOf(prev, payload) {
  return createHash('sha256')
    .update(prev + '\n' + JSON.stringify(payload))
    .digest('hex');
}

function rotateIfNeeded() {
  if (!(cfg.maxBytes > 0)) return;
  if (!existsSync(cfg.file)) return;
  let size;
  try {
    size = statSync(cfg.file).size;
  } catch {
    return;
  }
  if (size < cfg.maxBytes) return;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, 'Z');
  let target = path.join(path.dirname(cfg.file), `audit-${stamp}.jsonl`);
  let n = 1;
  while (existsSync(target)) target = path.join(path.dirname(cfg.file), `audit-${stamp}-${n++}.jsonl`);
  try {
    renameSync(cfg.file, target);
    chain.loaded = false;
    chain.seq = 0;
    chain.hash = GENESIS;
    chain.broke = false;
    chain.legacy = false;
    process.stderr.write(`[computer-use] audit log rotated to ${path.basename(target)}\n`);
  } catch (e) {
    process.stderr.write(`[computer-use] audit rotation failed: ${e.message}\n`);
  }
}

/* ------------------------------------------------------- chain head (anchor) */

/**
 * A small sidecar recording how far the current segment got.
 *
 * The chain alone cannot notice that its own tail was deleted: a truncated log
 * is still a perfectly valid chain. The head file is what makes deletion
 * visible — `verify` compares the file against it. Same trust caveat as
 * everything else here: an attacker who can write the log can also rewrite the
 * head, so this detects a partial edit, not a determined rewrite.
 */
function headPath() {
  return path.join(path.dirname(cfg.file), 'audit.head.json');
}

function readHead() {
  try {
    return JSON.parse(readFileSync(headPath(), 'utf8'));
  } catch {
    return null;
  }
}

function writeHead(entry) {
  try {
    writeFileSync(headPath(), JSON.stringify(entry) + '\n');
  } catch {
    /* the head is best-effort: never break the tool path for it */
  }
}

/* ------------------------------------------------------------------ writing */

/**
 * Append one record. Never throws: auditing must not break the tool path.
 * @returns {object|null} the record that was written
 */
export function record({ op, args = {}, target = null, ok = true, note = null } = {}) {
  try {
    if (!cfg.enabled()) return null;
    rotateIfNeeded();
    const c = ensureChain();
    const seq = c.seq + 1;
    const prev = c.hash;
    const payload = {
      seq,
      t: new Date().toISOString(),
      op,
      args: cfg.redact ? redactArgs(args) : (args ?? {}),
      target: normalizeTarget(target),
      ok: !!ok,
      note:
        note ??
        (c.broke
          ? 'chain reset: previous tail unreadable'
          : c.legacy
            ? 'chain started after legacy (pre-hash) records'
            : null),
    };
    const hash = hashOf(prev, payload);
    const line = JSON.stringify({ ...payload, prev, hash });
    appendFileSync(cfg.file, line + '\n');
    c.seq = seq;
    c.hash = hash;
    c.broke = false; // the reset is recorded once, not stamped on every record
    c.legacy = false;
    writeHead({ file: path.basename(cfg.file), seq, hash, updated: payload.t });
    if (cfg.alsoStderr) process.stderr.write(`[audit] ${line}\n`);
    return { ...payload, prev, hash };
  } catch (e) {
    process.stderr.write(`[computer-use] audit write failed: ${e.message}\n`);
    return null;
  }
}

/* ---------------------------------------------------------------- verifying */

/**
 * Verify one log segment against its own chain and against the chain head.
 *
 * Legacy records (written before hash chaining existed) are reported as such and
 * do not count as tampering: the whole point is to be able to upgrade an
 * existing audit.jsonl without declaring it forged. A line that is not JSON, a
 * record that lost its hash inside a chained segment, a broken link, or a file
 * that no longer reaches the recorded chain head *is* a problem.
 *
 * @returns {{file:string, records:number, legacy:number, ok:boolean,
 *            problems:Array<{line:number, why:string, legacy?:boolean}>,
 *            head:object|null, headNote:string|null}}
 */
export function verifyFile(file) {
  const problems = [];
  const head = readHead();
  const headHere = head && head.file === path.basename(file) ? head : null;

  if (!existsSync(file)) {
    if (headHere) {
      problems.push({
        line: 0,
        why: `log file is missing but the chain head records seq ${headHere.seq} (deleted?)`,
      });
      return { file, records: 0, legacy: 0, ok: false, problems, absent: true, head: headHere };
    }
    return { file, records: 0, legacy: 0, ok: true, problems, absent: true, head: null };
  }

  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim());
  let expectedPrev = null;
  let lastSeq = null;
  let count = 0; // chained records
  let legacy = 0; // pre-chain records

  // Records written before hash chaining existed sit at the START of the file;
  // anything hashless AFTER a chained record is a stripped hash, not history.
  // (A file whose hashes were all stripped is caught by the chain-head check
  // below, which still remembers how far the segment got.)
  let seenChained = false;

  lines.forEach((line, i) => {
    let doc;
    try {
      doc = JSON.parse(line);
    } catch {
      problems.push({ line: i + 1, why: 'not valid JSON' });
      return;
    }

    if (typeof doc.hash !== 'string' || doc.hash.length !== 64) {
      if (seenChained) {
        problems.push({ line: i + 1, why: 'record without a hash after a chained record (hash stripped)' });
        return;
      }
      legacy++;
      problems.push({ line: i + 1, why: 'legacy record (written before hash chaining)', legacy: true });
      return;
    }
    seenChained = true;

    const payload = payloadOf(doc);
    const hash = hashOf(doc.prev ?? '', payload);
    if (hash !== doc.hash) problems.push({ line: i + 1, why: 'hash mismatch (record edited)' });

    // Chain links are checked between consecutive *chained* records only, so an
    // unparseable or legacy line cannot cascade into false "broken link"
    // reports for every record after it.
    if (count === 0) {
      if (doc.prev !== GENESIS)
        problems.push({ line: i + 1, why: `segment does not start at genesis (prev=${doc.prev})` });
    } else if (doc.prev !== expectedPrev) {
      problems.push({
        line: i + 1,
        why: `broken link: prev=${String(doc.prev).slice(0, 12)}… expected ${String(expectedPrev).slice(0, 12)}…`,
      });
    }
    if (typeof doc.seq === 'number' && lastSeq !== null && doc.seq !== lastSeq + 1) {
      problems.push({ line: i + 1, why: `sequence gap: ${lastSeq} -> ${doc.seq}` });
    }
    expectedPrev = doc.hash;
    lastSeq = typeof doc.seq === 'number' ? doc.seq : null;
    count++;
  });

  // The head is the only thing that can notice a deleted tail or a wholesale
  // strip: a truncated or hashless log is still a valid file on its own.
  let headNote = null;
  if (headHere) {
    if (count === 0 && (headHere.seq ?? 0) > 0) {
      problems.push({
        line: 0,
        why: `no chained record is left, but the chain head recorded seq ${headHere.seq} (hashes stripped or log replaced)`,
      });
    } else if (count > 0 && typeof lastSeq === 'number' && lastSeq < headHere.seq) {
      problems.push({
        line: 0,
        why: `records deleted: the chain head recorded seq ${headHere.seq}, this file ends at ${lastSeq}`,
      });
    } else if (count > 0 && expectedPrev !== headHere.hash) {
      problems.push({ line: 0, why: 'the last record does not match the chain head (tail rewritten)' });
    } else {
      headNote = `matches the chain head (seq ${headHere.seq})`;
    }
  } else {
    headNote = 'no chain head recorded — a deleted tail cannot be detected';
  }

  const hard = problems.filter((p) => !p.legacy);
  return { file, records: count, legacy, ok: hard.length === 0, problems, head: headHere, headNote };
}

/** Verify audit.jsonl and every rotated segment next to it. */
export function verifyAll(dir = path.dirname(cfg.file)) {
  let files = [];
  try {
    files = readdirSync(dir)
      .filter((f) => f === 'audit.jsonl' || /^audit-.*\.jsonl$/.test(f))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    /* directory unreadable */
  }
  const results = files.map(verifyFile);
  return { ok: results.every((r) => r.ok), results };
}

/* ------------------------------------------------------------------ reading */

/** Last `n` records, parsed. Convenience for tests and debugging. */
export function tail(n = 10, file = cfg.file) {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim());
  return lines.slice(-n).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { unparsable: l };
    }
  });
}

/* ---------------------------------------------------------------------- CLI */

function cli(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'verify') {
    const { results } = rest.length ? { results: rest.map(verifyFile) } : verifyAll();
    let bad = 0;
    for (const r of results) {
      if (r.absent && r.ok) {
        process.stdout.write(`${path.basename(r.file)}: absent\n`);
        continue;
      }
      const legacy = r.legacy ? `, ${r.legacy} legacy` : '';
      process.stdout.write(`${path.basename(r.file)}: ${r.records} chained${legacy} — ${r.ok ? 'OK' : 'TAMPERED'}\n`);
      if (r.headNote) process.stdout.write(`  head: ${r.headNote}\n`);
      for (const p of r.problems) {
        if (p.legacy) continue;
        process.stdout.write(p.line ? `  line ${p.line}: ${p.why}\n` : `  ${path.basename(r.file)}: ${p.why}\n`);
      }
      if (r.legacy && r.records === 0) {
        process.stdout.write('  (pre-hash format: those records cannot be verified, only new ones are chained)\n');
      }
      if (!r.ok) bad++;
    }
    return bad ? 1 : 0;
  }
  if (cmd === 'tail') {
    const n = Number(rest[0] ?? 10) || 10;
    for (const r of tail(n)) process.stdout.write(JSON.stringify(r) + '\n');
    return 0;
  }
  process.stderr.write('usage: node src/audit.js <verify [file...] | tail [n]>\n');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = cli(process.argv.slice(2));
}
