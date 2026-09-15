/**
 * Tamper tests for src/audit.js that the in-chain tests cannot express:
 * deletion and hash-stripping.
 *
 * The chain alone cannot see a deleted tail — a truncated log is still a valid
 * chain — so `record()` also writes a chain head (audit.head.json) and
 * `verifyFile()` compares the file against it. These tests were written from an
 * adversarial review that was able to truncate, delete and strip the log while
 * `verify` still said OK.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configure, record, verifyFile } from '../src/audit.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let dir;
let file;
let head;

before(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'audit-tamper-'));
  file = path.join(dir, 'audit.jsonl');
  head = path.join(dir, 'audit.head.json');
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Five chained records and a matching head. */
function fresh(count = 5) {
  rmSync(file, { force: true });
  rmSync(head, { force: true });
  configure({ file, maxBytes: 0, redact: true });
  for (let i = 0; i < count; i++) record({ op: 'click', args: { n: i } });
  return readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

test('a matching log verifies against its chain head', () => {
  fresh();
  const v = verifyFile(file);
  assert.equal(v.ok, true);
  assert.equal(v.records, 5);
  assert.match(v.headNote, /matches the chain head \(seq 5\)/);
});

test('a truncated tail is detected', () => {
  const lines = fresh();
  writeFileSync(file, lines.slice(0, 3).join('\n') + '\n');
  const v = verifyFile(file);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => /records deleted: the chain head recorded seq 5/.test(p.why)));
});

test('deleting the whole log is detected', () => {
  fresh();
  rmSync(file, { force: true });
  const v = verifyFile(file);
  assert.equal(v.ok, false);
  assert.equal(v.absent, true);
  assert.ok(v.problems.some((p) => /log file is missing/.test(p.why)));
});

test('stripping every hash is detected instead of being called legacy', () => {
  const lines = fresh();
  const stripped = lines.map((l) => {
    const doc = JSON.parse(l);
    delete doc.hash;
    delete doc.prev;
    return JSON.stringify(doc);
  });
  writeFileSync(file, stripped.join('\n') + '\n');

  const v = verifyFile(file);
  assert.equal(v.ok, false, 'a rewritten, hashless log must not verify OK');
  assert.ok(v.problems.some((p) => /no chained record is left/.test(p.why)));
  // Legacy status is for a real pre-upgrade file, which has no head at all.
  assert.equal(existsSync(head), true, 'the head is what makes this detectable');
});

test('removing one hash after a chained record is tampering, not history', () => {
  const lines = fresh();
  const doc = JSON.parse(lines[1]);
  delete doc.hash;
  lines[1] = JSON.stringify(doc);
  writeFileSync(file, lines.join('\n') + '\n');

  const v = verifyFile(file);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => /hash stripped/.test(p.why)));
});

test('legacy records before the first chained record stay acceptable', () => {
  rmSync(file, { force: true });
  rmSync(head, { force: true });
  const legacy = JSON.stringify({ t: '2026-01-01T00:00:00.000Z', op: 'click', args: { x: 1 }, ok: true });
  writeFileSync(file, legacy + '\n');
  configure({ file, maxBytes: 0 });
  record({ op: 'key', args: { combo: 'a' } });
  record({ op: 'key', args: { combo: 'b' } });

  const v = verifyFile(file);
  assert.equal(v.ok, true, 'upgrading an existing log must not declare it forged');
  assert.equal(v.legacy, 1);
  assert.equal(v.records, 2);
});

test('an unchanged log still verifies after the head is rewritten by rotation', async () => {
  // Rotation starts a new segment with its own head; the old segment is left
  // alone and verifies on its own terms.
  rmSync(file, { force: true });
  rmSync(head, { force: true });
  configure({ file, maxBytes: 400 });
  for (let i = 0; i < 40; i++) record({ op: 'click', args: { n: i, pad: 'x'.repeat(20) } });
  await sleep(20);
  const rotated = readFileSync(path.join(dir, 'audit.head.json'), 'utf8');
  assert.match(rotated, /audit\.jsonl/);

  const current = verifyFile(file);
  assert.equal(current.ok, true, JSON.stringify(current.problems));
  assert.ok(current.records > 0);
});

/*
 * A log written by an old and a new build in turn has hashless lines scattered
 * through it, and the new build restarts its chain from genesis each time it
 * finds such a tail. Both are legitimate: neither may be reported as tampering,
 * and the tamper checks must still work on top of them.
 */
test('a log written by two versions verifies: legacy lines anywhere, several chain segments', () => {
  rmSync(file, { force: true });
  rmSync(head, { force: true });
  configure({ file, maxBytes: 0 });
  record({ op: 'click', args: { a: 1 } });
  record({ op: 'click', args: { a: 2 } });

  // The old build appends, in its own format (no seq / prev / hash).
  const legacyLine = JSON.stringify({ t: '2026-01-01T00:00:00.000Z', op: 'key', args: { combo: 'x' }, ok: true });
  writeFileSync(file, readFileSync(file, 'utf8') + legacyLine + '\n');

  // A new process reads that tail and starts a fresh segment.
  configure({ file, maxBytes: 0 });
  record({ op: 'key', args: { b: 1 } });
  record({ op: 'key', args: { b: 2 } });

  const v = verifyFile(file);
  assert.equal(v.ok, true, `expected OK, got ${JSON.stringify(v.problems)}`);
  assert.equal(v.legacy, 1);
  assert.equal(v.records, 4);
  assert.equal(v.segments, 2);
  assert.match(v.headNote, /2 chain segments/);

  // The checks that matter still fire on that same log.
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const stripped = JSON.parse(lines[0]);
  delete stripped.hash;
  lines[0] = JSON.stringify(stripped);
  writeFileSync(file, lines.join('\n') + '\n');
  const after = verifyFile(file);
  assert.equal(after.ok, false);
  assert.ok(after.problems.some((p) => /lost its hash/.test(p.why)));
});
