/**
 * Unit tests for src/guard.js — the HMAC-signed "protection layer off" markers.
 *
 * Every test points `configure({dir})` at a fresh temp directory, so the real
 * .guard-off / .approval-off / .audit-off / .physical-off markers and the real
 * guard.key in the repo root are never read or written. assert.throws is used
 * for the unknown-switch paths precisely so no real marker can ever be created.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/paths.js';
import { tempDir, removeDir } from './helpers/tmp.mjs';
import {
  SWITCH_NAMES, MARKERS, KEY_NAME, configure, switchState, readSwitch, isOff,
  setSwitch, tamperWarning, tamperEvents_, _resetTamperState, markerPath, keyPath,
} from '../src/guard.js';

let dir;

before(() => {
  dir = tempDir('guard');
  configure({ dir });
});

after(() => { removeDir(dir); });

/** A fresh temp dir per test, so cases cannot see each other's markers. */
function fresh() {
  const d = tempDir('guard');
  configure({ dir: d });
  return d;
}

test('marker names map to the documented dot-files', () => {
  assert.deepEqual(SWITCH_NAMES, ['approval', 'guard', 'audit', 'physical']);
  assert.equal(MARKERS.approval, '.approval-off');
  assert.equal(MARKERS.guard, '.guard-off');
  assert.equal(MARKERS.audit, '.audit-off');
  assert.equal(MARKERS.physical, '.physical-off');
});

test('an absent marker means the switch is ON', () => {
  const d = fresh();
  try {
    for (const name of SWITCH_NAMES) {
      const s = readSwitch(name);
      assert.equal(s.name, name);
      assert.equal(s.path, path.join(d, MARKERS[name]));
      assert.equal(s.exists, false);
      assert.equal(s.off, false);
      assert.equal(s.signed, false);
      assert.equal(s.tampered, false);
      assert.equal(s.at, null);
      assert.equal(s.reason, null);
      assert.equal(isOff(name), false);
      assert.equal(tamperWarning(), null);
    }
    assert.deepEqual(switchState(), { approval: 'on', guard: 'on', audit: 'on', physical: 'on' });
  } finally { removeDir(d); }
});

test('an unknown switch name throws instead of resolving to a real repo path', () => {
  assert.throws(() => markerPath('nonexistent'), /unknown guard switch/);
  assert.throws(() => readSwitch('nonexistent'), /unknown guard switch/);
  assert.throws(() => setSwitch('nonexistent', true), /unknown guard switch/);
});

test('configure creates nothing in the repo root and keeps guard.key in the temp dir', () => {
  const d = fresh();
  try {
    const realKey = path.join(ROOT, KEY_NAME);
    const keyExistedBefore = existsSync(realKey);
    for (const name of SWITCH_NAMES) readSwitch(name);      // reads must not write anything
    assert.equal(existsSync(realKey), keyExistedBefore, 'the real guard.key must not be created');
    assert.equal(existsSync(keyPath()), false, 'reading switches alone signs nothing');

    setSwitch('guard', true);                               // generation happens here
    assert.equal(keyPath(), path.join(d, KEY_NAME));
    assert.equal(existsSync(keyPath()), true);
    assert.match(readFileSync(keyPath(), 'utf8').trim(), /^[0-9a-f]{64}$/);
    assert.equal(existsSync(realKey), keyExistedBefore);
    for (const name of SWITCH_NAMES) assert.equal(existsSync(path.join(ROOT, MARKERS[name])), false);
  } finally { removeDir(d); }
});

test('a plain (unsigned, empty) marker fails closed: tampered, still ON, with a warning', () => {
  const d = fresh();
  try {
    writeFileSync(markerPath('guard'), '');
    const s = readSwitch('guard');
    assert.equal(s.exists, true);
    assert.equal(s.off, false, 'an unsigned marker must not turn the layer off');
    assert.equal(s.signed, false);
    assert.equal(s.tampered, true);
    assert.equal(s.reason, 'not a signed guard-panel marker');

    assert.equal(switchState().guard, 'tampered');
    const warning = tamperWarning();
    assert.equal(typeof warning, 'string');
    assert.match(warning, /guard/, 'the warning names the offending switch');
    assert.equal(tamperEvents_().length, 1);
    assert.equal(tamperEvents_()[0].name, 'guard');
    assert.equal(tamperEvents_()[0].reason, 'not a signed guard-panel marker');
  } finally { removeDir(d); }
});

test('a non-JSON marker is reported as tampered', () => {
  const d = fresh();
  try {
    writeFileSync(markerPath('audit'), 'this is not json\n');
    const s = readSwitch('audit');
    assert.equal(s.exists, true);
    assert.equal(s.off, false);
    assert.equal(s.tampered, true);
    assert.equal(s.signed, false);
    assert.equal(s.reason, 'not a signed guard-panel marker');
    assert.equal(switchState().audit, 'tampered');
  } finally { removeDir(d); }
});

test('tamper events are de-duplicated per switch and reason', () => {
  const d = fresh();
  try {
    writeFileSync(markerPath('physical'), '');
    readSwitch('physical');
    readSwitch('physical');
    readSwitch('physical');
    assert.equal(tamperEvents_().length, 1);
    _resetTamperState();
    assert.equal(tamperEvents_().length, 0);
    assert.equal(tamperWarning(), null);
  } finally { removeDir(d); }
});

test('setSwitch(name, true) writes a signed marker that reads back as off', () => {
  const d = fresh();
  try {
    const r = setSwitch('guard', true);
    assert.equal(r.ok, true);
    assert.equal(r.name, 'guard');
    assert.equal(r.off, true);
    assert.equal(r.path, markerPath('guard'));
    assert.equal(r.error, undefined);

    const doc = JSON.parse(readFileSync(markerPath('guard'), 'utf8'));
    assert.equal(doc.v, 1);
    assert.equal(doc.switch, 'guard');
    assert.equal(doc.off, true);
    assert.equal(doc.by, 'guard-panel');
    assert.match(doc.sig, /^[0-9a-f]{64}$/);

    const s = readSwitch('guard');
    assert.equal(s.signed, true);
    assert.equal(s.off, true);
    assert.equal(s.tampered, false);
    assert.equal(s.at, doc.at);
    assert.equal(isOff('guard'), true);
    assert.equal(switchState().guard, 'off');
    assert.equal(tamperWarning(), null);
  } finally { removeDir(d); }
});

test('setSwitch(name, false) removes the marker and the switch returns to on', () => {
  const d = fresh();
  try {
    setSwitch('audit', true);
    assert.equal(isOff('audit'), true);

    const r = setSwitch('audit', false);
    assert.equal(r.ok, true);
    assert.equal(r.off, false);
    assert.equal(existsSync(markerPath('audit')), false);

    const s = readSwitch('audit');
    assert.equal(s.exists, false);
    assert.equal(s.off, false);
    assert.equal(s.tampered, false);
    assert.equal(switchState().audit, 'on');
    assert.equal(tamperWarning(), null);
  } finally { removeDir(d); }
});

test('flipping one character of a marker sig makes it tampered', () => {
  const d = fresh();
  try {
    setSwitch('approval', true);
    const file = markerPath('approval');
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    const flipped = (doc.sig[0] === '0' ? '1' : '0') + doc.sig.slice(1);
    assert.notEqual(flipped, doc.sig);
    writeFileSync(file, JSON.stringify({ ...doc, sig: flipped }));

    const s = readSwitch('approval');
    assert.equal(s.exists, true);
    assert.equal(s.signed, false);
    assert.equal(s.off, false, 'a bad signature must fail closed');
    assert.equal(s.tampered, true);
    assert.equal(s.reason, 'signature mismatch (hand-edited or forged)');
    assert.equal(switchState().approval, 'tampered');
    assert.match(tamperWarning(), /approval/);
  } finally { removeDir(d); }
});

test('a validly signed marker for another switch at this path is tampered (switch mismatch)', () => {
  const d = fresh();
  try {
    // Sign for 'audit' using the same secret and shape the panel would use, then
    // plant it where '.guard-off' is expected.
    setSwitch('audit', true);
    const auditDoc = readFileSync(markerPath('audit'), 'utf8');
    writeFileSync(markerPath('guard'), auditDoc);

    const s = readSwitch('guard');
    assert.equal(s.exists, true);
    assert.equal(s.off, false, 'a marker naming another switch is ignored');
    assert.equal(s.signed, false);
    assert.equal(s.tampered, true);
    assert.equal(s.reason, 'not a signed guard-panel marker');
    assert.equal(switchState().guard, 'tampered');
    // The genuine marker for its own switch is still honoured.
    assert.equal(isOff('audit'), true);
    assert.equal(switchState().audit, 'off');
  } finally { removeDir(d); }
});

test('a marker whose timestamp was edited after signing is tampered', () => {
  const d = fresh();
  try {
    // Sign, then change `at` in place: the HMAC covers `at`, so it must fail.
    setSwitch('physical', true);
    const doc = JSON.parse(readFileSync(markerPath('physical'), 'utf8'));
    writeFileSync(markerPath('physical'), JSON.stringify({ ...doc, at: '1999-01-01T00:00:00.000Z' }));

    const s = readSwitch('physical');
    assert.equal(s.tampered, true);
    assert.equal(s.off, false);
    assert.equal(s.reason, 'signature mismatch (hand-edited or forged)');
    assert.equal(tamperEvents_().length, 1);
  } finally { removeDir(d); }
});

test('COMPUTER_USE_GUARD_ALLOW_PLAIN=1 honours a plain marker but still reports tampering', () => {
  const d = fresh();
  const saved = process.env.COMPUTER_USE_GUARD_ALLOW_PLAIN;
  try {
    process.env.COMPUTER_USE_GUARD_ALLOW_PLAIN = '1';
    writeFileSync(markerPath('guard'), '');

    const s = readSwitch('guard');
    assert.equal(s.exists, true);
    assert.equal(s.off, true, 'the plain marker is honoured under the env opt-out');
    assert.equal(s.signed, false);
    assert.equal(s.tampered, true, 'but it is still reported as tampering');
    assert.equal(s.reason, 'unsigned (allowed by env)');
    assert.equal(isOff('guard'), true);
    assert.equal(switchState().guard, 'tampered');
    const warning = tamperWarning();
    assert.match(warning, /guard/);
    assert.match(warning, /failed signature verification/);

    const events = tamperEvents_();
    assert.equal(events.length, 1);
    assert.match(events[0].reason, /COMPUTER_USE_GUARD_ALLOW_PLAIN=1/);
    assert.equal(events[0].detail, '', 'the offending content is captured (empty marker)');
  } finally {
    if (saved === undefined) delete process.env.COMPUTER_USE_GUARD_ALLOW_PLAIN;
    else process.env.COMPUTER_USE_GUARD_ALLOW_PLAIN = saved;
    removeDir(d);
  }
});

test('removing the offending marker makes the state clean again', () => {
  const d = fresh();
  try {
    setSwitch('approval', true);
    const file = markerPath('approval');
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...doc, sig: 'f'.repeat(64) }));
    assert.equal(readSwitch('approval').tampered, true);
    assert.notEqual(tamperWarning(), null);

    // Keep the path warm so a stale cache could be observed.
    utimesSync(file, new Date(), new Date());
    setSwitch('approval', false);                  // removes the file legitimately
    assert.equal(existsSync(file), false);
    _resetTamperState();

    const s = readSwitch('approval');
    assert.equal(s.exists, false);
    assert.equal(s.tampered, false);
    assert.equal(s.off, false);
    assert.equal(switchState().approval, 'on');
    assert.equal(tamperWarning(), null, 'no tamper events remain after a clean re-read');
    assert.deepEqual(tamperEvents_(), []);
  } finally { removeDir(d); }
});
