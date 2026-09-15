/**
 * The tamper warning has to disappear when the offending marker does, or the
 * cost of a planted file is paid by every later tool result in that process.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  configure,
  switchState,
  readSwitch,
  tamperWarning,
  tamperEvents_,
  _resetTamperState,
} from '../src/guard.js';

test('the tamper warning is dropped once the bad marker is removed, but the history is kept', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'guard-warn-'));
  configure({ dir });
  _resetTamperState();

  assert.equal(tamperWarning(), null, 'a clean checkout warns about nothing');

  writeFileSync(path.join(dir, '.guard-off'), '');
  assert.equal(switchState().guard, 'tampered');
  const warning = tamperWarning();
  assert.ok(warning, 'an unsigned marker is reported');
  assert.match(warning, /guard/);

  rmSync(path.join(dir, '.guard-off'));
  assert.equal(switchState().guard, 'on', 'the layer was never off');
  assert.equal(tamperWarning(), null, 'no warning is charged to later calls once it is fixed');
  assert.equal(tamperEvents_().length, 1, 'the audit history still has the event');

  // And it comes back if the marker does.
  writeFileSync(path.join(dir, '.guard-off'), '');
  readSwitch('guard');
  assert.ok(tamperWarning());

  rmSync(dir, { recursive: true, force: true });
  _resetTamperState();
});
