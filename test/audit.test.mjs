/**
 * Unit tests for src/audit.js — redaction and the tamper-evident hash chain.
 *
 * `configure({file})` always points at a temp path, so the repository's own
 * audit.jsonl is never written.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tempDir, removeDir } from './helpers/tmp.mjs';
import {
  GENESIS, DEFAULT_REDACT_KEYS, configure, auditConfig, record, redactArgs,
  redactScalar, verifyFile, verifyAll, tail,
} from '../src/audit.js';

const sha12 = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
const rawLines = (file) => readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
const writeLines = (file, lines) => writeFileSync(file, lines.map((l) => l + '\n').join(''));

const bootDir = tempDir('audit-boot');

before(() => {
  configure({ file: path.join(bootDir, 'audit.jsonl'), maxBytes: 0, redact: true });
});

after(() => { removeDir(bootDir); });

/** Fresh temp dir + fresh audit file with rotation disabled. */
function fresh() {
  const dir = tempDir('audit');
  const file = path.join(dir, 'audit.jsonl');
  configure({ file, maxBytes: 0, redact: true, enabled: () => true, redactKeys: DEFAULT_REDACT_KEYS });
  return { dir, file };
}

test('DEFAULT_REDACT_KEYS covers the documented sensitive argument names', () => {
  for (const key of ['text', 'password', 'secret', 'token', 'api_key', 'authorization', 'cookie', 'otp', 'pin']) {
    assert.ok(DEFAULT_REDACT_KEYS.includes(key), `expected default redaction for "${key}"`);
  }
});

test('three records verify OK with seq 1..3 and the first prev === genesis', () => {
  const { dir, file } = fresh();
  try {
    const a = record({ op: 'click', args: { x: 10, y: 20 }, target: { process: 'notepad' }, ok: true });
    const b = record({ op: 'type_text', args: { text: 'hello' }, ok: true });
    const c = record({ op: 'key', args: { combo: 'ctrl+s' }, ok: false, note: 'no window' });

    assert.equal(a.seq, 1);
    assert.equal(b.seq, 2);
    assert.equal(c.seq, 3);
    assert.equal(a.prev, GENESIS);
    assert.equal(b.prev, a.hash);
    assert.equal(c.prev, b.hash);
    assert.match(a.hash, /^[0-9a-f]{64}$/);

    const v = verifyFile(file);
    assert.equal(v.file, file);
    assert.equal(v.records, 3);
    assert.equal(v.ok, true);
    assert.deepEqual(v.problems, []);

    const parsed = rawLines(file).map((l) => JSON.parse(l));
    assert.deepEqual(parsed.map((r) => r.seq), [1, 2, 3]);
    assert.equal(parsed[0].prev, 'genesis');
    assert.equal(parsed[0].op, 'click');
    assert.equal(parsed[2].ok, false);
    assert.equal(parsed[2].note, 'no window');
  } finally { removeDir(dir); }
});

test('args.text is redacted to {redacted,chars,sha256} while x/y survive', () => {
  const { dir, file } = fresh();
  try {
    const r = record({ op: 'type_text', args: { text: 'hunter2', x: 1, y: 2 } });
    assert.deepEqual(r.args.x, 1);
    assert.deepEqual(r.args.y, 2);
    assert.deepEqual(r.args.text, { redacted: true, chars: 7, sha256: sha12('hunter2') });
    assert.equal(JSON.stringify(r.args).includes('hunter2'), false, 'plaintext must not survive in args');

    const onDisk = JSON.parse(rawLines(file)[0]);
    assert.deepEqual(onDisk.args.text, { redacted: true, chars: 7, sha256: sha12('hunter2') });
  } finally { removeDir(dir); }
});

test('redaction recurses into arrays of objects (batch steps[].args.text)', () => {
  const { dir, file } = fresh();
  try {
    const steps = [{ op: 'type_text', args: { text: 'hunter2', window: 'Notepad' } }];
    const r = record({ op: 'batch', args: { steps } });

    assert.equal(r.args.steps.length, 1);
    assert.equal(r.args.steps[0].op, 'type_text');
    assert.equal(r.args.steps[0].args.window, 'Notepad');
    assert.deepEqual(r.args.steps[0].args.text, { redacted: true, chars: 7, sha256: sha12('hunter2') });
    assert.equal(JSON.stringify(r.args).includes('hunter2'), false);
    assert.equal(readFileSync(file, 'utf8').includes('hunter2'), false);
  } finally { removeDir(dir); }
});

test('redactScalar and redactArgs keep non-sensitive values byte-identical', () => {
  assert.deepEqual(redactScalar('abc'), { redacted: true, chars: 3, sha256: sha12('abc') });
  assert.deepEqual(redactScalar(null), null);
  assert.deepEqual(redactScalar(undefined), undefined);
  assert.deepEqual(redactScalar(1234), { redacted: true, chars: 4, sha256: sha12('1234') });

  assert.deepEqual(redactArgs({ x: 1, note: 'visible', Password: 'p' }), {
    x: 1,
    note: 'visible',
    Password: { redacted: true, chars: 1, sha256: sha12('p') },
  });
  assert.deepEqual(redactArgs({ custom: 'v' }, ['custom']).custom, {
    redacted: true, chars: 1, sha256: sha12('v'),
  });
  assert.deepEqual(redactArgs(undefined), {});
});

test('enabled: () => false writes nothing and creates no file', () => {
  const { dir, file } = fresh();
  try {
    configure({ enabled: () => false });
    assert.equal(record({ op: 'click', args: { x: 1, y: 1 } }), null);
    assert.equal(record({ op: 'key', args: { combo: 'a' } }), null);
    assert.equal(existsSync(file), false);
    assert.equal(auditConfig().enabled(), false);

    configure({ enabled: () => true });
    const r = record({ op: 'click', args: { x: 1, y: 1 } });
    assert.equal(r.seq, 1, 'the chain restarts once auditing is re-enabled on an empty file');
    assert.equal(existsSync(file), true);
  } finally { removeDir(dir); }
});

test('verifyFile detects an edited field value (hash mismatch)', () => {
  const { dir, file } = fresh();
  try {
    record({ op: 'click', args: { x: 1, y: 1 } });
    record({ op: 'key', args: { combo: 'a' } });
    record({ op: 'scroll', args: { amount: 3 } });

    const lines = rawLines(file);
    const doc = JSON.parse(lines[0]);
    lines[0] = JSON.stringify({ ...doc, op: 'launch_app' });   // edit one field, keep prev/hash
    writeLines(file, lines);

    const v = verifyFile(file);
    assert.equal(v.ok, false);
    assert.equal(v.records, 3);
    assert.deepEqual(v.problems, [{ line: 1, why: 'hash mismatch (record edited)' }]);
  } finally { removeDir(dir); }
});

test('verifyFile detects a deleted middle line (broken link AND sequence gap)', () => {
  const { dir, file } = fresh();
  try {
    record({ op: 'click', args: { x: 1 } });
    record({ op: 'key', args: { combo: 'a' } });
    record({ op: 'scroll', args: { amount: 3 } });

    const lines = rawLines(file);
    writeLines(file, [lines[0], lines[2]]);       // drop record #2

    const v = verifyFile(file);
    assert.equal(v.ok, false);
    assert.equal(v.records, 2);
    assert.equal(v.problems.length, 2);
    assert.equal(v.problems[0].line, 2);
    assert.match(v.problems[0].why, /broken link/);
    assert.equal(v.problems[1].line, 2);
    assert.match(v.problems[1].why, /sequence gap: 1 -> 3/);
  } finally { removeDir(dir); }
});

test('verifyFile detects an appended record forged with a made-up prev/hash', () => {
  const { dir, file } = fresh();
  try {
    record({ op: 'click', args: { x: 1 } });
    record({ op: 'key', args: { combo: 'a' } });

    const forged = {
      seq: 3,
      t: new Date().toISOString(),
      op: 'type_text',
      args: { text: { redacted: true, chars: 3, sha256: sha12('abc') } },
      target: null,
      ok: true,
      note: null,
      prev: 'deadbeef'.repeat(8),
      hash: 'c0ffee'.repeat(10) + 'c0ff',           // 64 chars, made up
    };
    assert.equal(forged.hash.length, 64);
    writeFileSync(file, rawLines(file).map((l) => l + '\n').join('') + JSON.stringify(forged) + '\n');

    const v = verifyFile(file);
    assert.equal(v.ok, false);
    assert.equal(v.records, 3);
    // The forged record trips the hash check and the chain link; the chain head
    // (written by the real records) then notices that the tail it recorded is
    // gone, so the count is not pinned here — the reasons are.
    const whys = v.problems.map((p) => p.why);
    assert.equal(v.problems[0].line, 3);
    assert.equal(v.problems[0].why, 'hash mismatch (record edited)');
    assert.equal(v.problems[1].line, 3);
    assert.match(v.problems[1].why, /broken link/);
    assert.ok(
      whys.some((w) => /chain head/.test(w)),
      `expected a chain-head problem, got: ${JSON.stringify(whys)}`,
    );
  } finally { removeDir(dir); }
});

test('verifyFile flags a segment that does not start at genesis', () => {
  const { dir, file } = fresh();
  try {
    record({ op: 'click', args: { x: 1 } });
    record({ op: 'key', args: { combo: 'a' } });
    const lines = rawLines(file);
    writeLines(file, [lines[1]]);                 // only the second record survives

    const v = verifyFile(file);
    assert.equal(v.ok, false);
    assert.equal(v.records, 1);
    assert.equal(v.problems[0].line, 1);
    assert.match(v.problems[0].why, /does not start at genesis/);
  } finally { removeDir(dir); }
});

test('verifyFile reports an absent file as OK and flags non-JSON lines', () => {
  const { dir, file } = fresh();
  try {
    const absent = verifyFile(file);
    assert.equal(absent.records, 0);
    assert.equal(absent.ok, true);
    assert.equal(absent.absent, true);
    assert.deepEqual(absent.problems, []);

    writeFileSync(file, 'not json at all\n');
    const bad = verifyFile(file);
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.problems, [{ line: 1, why: 'not valid JSON' }]);
  } finally { removeDir(dir); }
});

test('verifyAll checks audit.jsonl and every rotated segment next to it', () => {
  const dir = tempDir('audit-all');
  try {
    const main = path.join(dir, 'audit.jsonl');
    const rotated = path.join(dir, 'audit-20260101T000000Z.jsonl');
    const sub = path.join(dir, 'nested');
    mkdirSync(sub);

    configure({ file: main, maxBytes: 0 });
    record({ op: 'click', args: { x: 1 } });
    record({ op: 'key', args: { combo: 'a' } });

    // A rotated segment starts its own chain at genesis.
    writeFileSync(rotated, '');
    configure({ file: rotated, maxBytes: 0 });
    record({ op: 'type_text', args: { text: 'x' } });
    assert.equal(JSON.parse(rawLines(rotated)[0]).prev, GENESIS);
    assert.equal(JSON.parse(rawLines(rotated)[0]).seq, 1);

    const all = verifyAll(dir);
    assert.equal(all.ok, true);
    assert.deepEqual(all.results.map((r) => path.basename(r.file)), ['audit-20260101T000000Z.jsonl', 'audit.jsonl']);
    assert.deepEqual(all.results.map((r) => r.records), [1, 2]);

    // Corrupt the rotated segment: verifyAll must notice.
    const lines = rawLines(rotated);
    const doc = JSON.parse(lines[0]);
    writeLines(rotated, [JSON.stringify({ ...doc, op: 'launch_app' })]);
    const bad = verifyAll(dir);
    assert.equal(bad.ok, false);
    assert.equal(bad.results.find((r) => r.file === rotated).ok, false);
    assert.equal(bad.results.find((r) => r.file === main).ok, true);
  } finally { removeDir(dir); }
});

test('configure on a fresh path restarts the chain at genesis', () => {
  const { dir, file } = fresh();
  try {
    record({ op: 'click', args: { x: 1 } });
    record({ op: 'click', args: { x: 2 } });

    const dir2 = tempDir('audit');
    const file2 = path.join(dir2, 'audit.jsonl');
    try {
      configure({ file: file2, maxBytes: 0 });
      const r = record({ op: 'click', args: { x: 3 } });
      assert.equal(r.seq, 1);
      assert.equal(r.prev, GENESIS);
      assert.equal(verifyFile(file2).ok, true);
      // The old file is untouched and still a valid chain of two.
      assert.equal(verifyFile(file).records, 2);
    } finally { removeDir(dir2); }
  } finally { removeDir(dir); }
});

test('tail(n) returns the last n parsed records in order', () => {
  const { dir, file } = fresh();
  try {
    assert.deepEqual(tail(5, file), [], 'an absent file tails to nothing');

    for (let i = 1; i <= 5; i++) record({ op: `op${i}`, args: {} });

    const last2 = tail(2, file);
    assert.equal(last2.length, 2);
    assert.deepEqual(last2.map((r) => r.op), ['op4', 'op5']);
    assert.deepEqual(last2.map((r) => r.seq), [4, 5]);

    assert.equal(tail(99, file).length, 5);
    assert.deepEqual(tail(5, file).map((r) => r.op), ['op1', 'op2', 'op3', 'op4', 'op5']);
  } finally { removeDir(dir); }
});

test('rotation moves the segment aside and starts a new chain at genesis', () => {
  const dir = tempDir('audit-rot');
  const file = path.join(dir, 'audit.jsonl');
  try {
    configure({ file, maxBytes: 0 });
    record({ op: 'click', args: { x: 1 } });

    configure({ file, maxBytes: 1 });             // any non-empty file is "too big"
    const r = record({ op: 'key', args: { combo: 'a' } });
    assert.equal(r.seq, 1, 'the new segment restarts at seq 1');
    assert.equal(r.prev, GENESIS);

    const rotated = readdirSync(dir).filter((f) => /^audit-.*\.jsonl$/.test(f));
    assert.equal(rotated.length, 1);
    assert.equal(verifyFile(path.join(dir, rotated[0])).records, 1);
    assert.equal(verifyFile(path.join(dir, rotated[0])).ok, true);
    assert.equal(verifyFile(file).records, 1);
    assert.equal(JSON.parse(rawLines(file)[0]).op, 'key');
  } finally {
    configure({ maxBytes: 0 });
    removeDir(dir);
  }
});

/*
 * Regression: a single unreadable/garbage tail used to poison everything after
 * it — `chain.broke` was never cleared, so every later record carried the reset
 * note, and the verifier cascaded a false "broken link" onto the first good
 * record. Now the reset is recorded once, and chain links are only checked
 * between consecutive chained records.
 */
test('an unreadable tail resets the chain once, not on every later record', () => {
  const { dir, file } = fresh();
  try {
    record({ op: 'click', args: { x: 1 } });
    writeFileSync(file, 'GARBAGE NOT JSON\n');       // the previous tail is now unreadable
    configure({ file, maxBytes: 0 });                // drop the cached chain, re-read from disk

    const a = record({ op: 'key', args: { combo: 'a' } });
    const b = record({ op: 'click', args: { x: 2 } });
    assert.equal(a.seq, 1);
    assert.equal(a.prev, GENESIS);
    assert.equal(b.seq, 2);
    assert.equal(a.note, 'chain reset: previous tail unreadable');
    assert.equal(b.note, null, 'the reset is recorded once, not stamped on every later record');

    const v = verifyFile(file);
    assert.equal(v.ok, false, 'the garbage line is still reported');
    assert.equal(v.records, 2);
    assert.equal(v.legacy, 0);
    // Exactly one problem: the garbage line. The two good records after it form
    // a valid chain and must not be reported as broken links.
    assert.deepEqual(v.problems.map((p) => p.line), [1]);
    assert.equal(v.problems[0].why, 'not valid JSON');
    assert.equal(readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length, 3,
      'the file really holds three lines');
  } finally { removeDir(dir); }
});

/*
 * Upgrading an existing audit.jsonl must not declare the old records forged:
 * records written before hash chaining have no `hash`, are counted as legacy,
 * are not verifiable, and do not make `ok` false.
 */
test('legacy pre-hash records are reported as legacy, not as tampering', () => {
  const { dir, file } = fresh();
  try {
    const legacyLine = JSON.stringify({ t: '2026-01-01T00:00:00.000Z', op: 'click', args: { x: 1 }, ok: true });
    writeFileSync(file, legacyLine + '\n');
    configure({ file, maxBytes: 0 });

    const first = record({ op: 'key', args: { combo: 'a' } });
    assert.equal(first.prev, GENESIS);
    assert.equal(first.note, 'chain started after legacy (pre-hash) records');

    const v = verifyFile(file);
    assert.equal(v.ok, true, 'legacy records are not tampering');
    assert.equal(v.legacy, 1);
    assert.equal(v.records, 1);
    assert.deepEqual(v.problems.map((p) => p.line), [1]);
    assert.equal(v.problems[0].legacy, true);
  } finally { removeDir(dir); }
});

test('window titles are capped at 80 characters, and fingerprinted on request', () => {
  const { dir, file } = fresh();
  try {
    const long = 'x'.repeat(200);
    record({ op: 'click', args: { x: 1 }, target: { process: 'chrome', title: long } });
    const kept = tail(1, file)[0];
    assert.equal(kept.target.process, 'chrome');
    assert.equal(kept.target.title.length, 80);

    configure({ file, maxBytes: 0, redactTitles: true });
    record({ op: 'click', args: { x: 2 }, target: { process: 'chrome', title: 'Password hunter2 - Chrome' } });
    const redacted = tail(1, file)[0];
    assert.equal(redacted.target.title.redacted, true);
    assert.equal(redacted.target.title.chars, 'Password hunter2 - Chrome'.length);
    assert.equal(readFileSync(file, 'utf8').includes('hunter2'), false, 'no plain title on disk');
    assert.equal(verifyFile(file).ok, true, 'redaction does not break the chain');
  } finally { removeDir(dir); }
});
