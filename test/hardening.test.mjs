/**
 * Regression tests for the hardening pass that followed the adversarial review:
 * launch targets, secondary targets, the single-dialog gate, marker replay,
 * child-process environments and the per-session "remember" key.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as guard from '../src/guard.js';
import { childEnv } from '../src/shell.js';
import {
  configurePolicyPath,
  reloadPolicy,
  policyGuard,
  needsApproval,
  targetList,
  launchGuard,
  _resetRateLimit,
  DEFAULT_POLICY,
} from '../src/policy.js';
import {
  gate,
  approvalKey,
  rememberSession,
  isSessionApproved,
  _resetSessionApprovals,
  approvalBusy,
  blockedWhileApprovalPending,
} from '../src/approval.js';

let runDir;
const originalPolicy = path.join(process.cwd(), 'policy.json');

before(() => {
  runDir = mkdtempSync(path.join(tmpdir(), 'hardening-'));
  guard.configure({ dir: runDir });
  configurePolicyPath(path.join(runDir, 'policy.json'));
  reloadPolicy(); // no file there -> defaults
  _resetRateLimit();
});

after(() => {
  configurePolicyPath(originalPolicy);
  reloadPolicy();
  rmSync(runDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------ launchGuard */

test('launchGuard refuses shells and LOLBins, and allows ordinary programs', () => {
  _resetRateLimit();
  for (const target of ['cmd.exe', 'cmd', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'pwsh', 'mshta.exe', 'certutil']) {
    const r = launchGuard({ target });
    assert.ok(r, `expected ${target} to be refused`);
    assert.equal(r.isError, true);
    assert.match(JSON.parse(r.content[0].text).reason, /deny\/launch list/);
  }
  for (const target of ['notepad.exe', 'calc.exe', 'C:\\Program Files\\Blender\\blender.exe', 'https://example.com']) {
    assert.equal(launchGuard({ target }), null, `expected ${target} to be allowed`);
  }
  // The process deny list applies too: launching a password manager is refused.
  assert.ok(launchGuard({ target: 'C:\\Program Files\\KeePassXC\\KeePassXC.exe' }));
});

test('launchGuard is skipped when the guard master switch is off', () => {
  guard.setSwitch('guard', true);
  try {
    assert.equal(launchGuard({ target: 'cmd.exe' }), null);
  } finally {
    guard.setSwitch('guard', false);
  }
});

/* ----------------------------------------------------- secondary targets */

test('a drag is checked at both ends, not only where it starts', () => {
  const start = { process: 'explorer', title: 'Desktop', found: true };
  const drop = { process: 'KeePassXC', title: 'KeePassXC', found: true, __source: 'point' };
  const target = { ...start, also: [drop] };

  assert.deepEqual(targetList(target).length, 2, 'both points are consulted');
  const blocked = policyGuard('drag', { x1: 1, y1: 1, x2: 2, y2: 2 }, target);
  assert.ok(blocked, 'dropping into a deny-listed window must be refused');
  const body = JSON.parse(blocked.content[0].text);
  assert.equal(body.blocked_by_policy, true);
  assert.match(body.reason, /secondary target/);
  assert.equal(body.detail.process, 'KeePassXC');
});

test('an approval-listed window at the drop point asks for approval too', () => {
  configurePolicyPath(path.join(runDir, 'policy-approval.json'));
  writeFileSync(
    path.join(runDir, 'policy-approval.json'),
    JSON.stringify({ ...DEFAULT_POLICY, approval_processes: ['wechat'], deny_processes: [] }),
  );
  reloadPolicy();
  try {
    const target = {
      process: 'explorer',
      title: 'Desktop',
      found: true,
      also: [{ process: 'WeChat', title: 'WeChat', found: true }],
    };
    const check = needsApproval('drag', { x1: 1, y1: 1, x2: 2, y2: 2 }, target);
    assert.equal(check.source, 'list');
    assert.match(check.reason, /secondary target process/);
  } finally {
    configurePolicyPath(path.join(runDir, 'policy.json'));
    reloadPolicy();
  }
});

/* ---------------------------------------------------- the marker watermark */

test('a replayed (old, validly signed) marker is refused', () => {
  guard._resetTamperState();
  guard.setSwitch('audit', true);
  const markerPath = guard.markerPath('audit');
  const captured = readFileSync(markerPath, 'utf8');

  // The server reads the marker on every gated call — that read is what records
  // how far the switch has got. Emulate it, then let the user change their mind.
  assert.equal(guard.isOff('audit'), true);
  guard.setSwitch('audit', false); // back on

  writeFileSync(markerPath, captured); // the attacker restores the old bytes
  const state = guard.readSwitch('audit');
  assert.equal(state.tampered, true, 'an old marker must not be honoured again');
  assert.match(state.reason, /replayed marker/);
  assert.equal(guard.isOff('audit'), false, 'fail closed: the layer stays on');

  guard.setSwitch('audit', false);
  guard._resetTamperState();
});

test('two toggles in the same millisecond both take effect', () => {
  guard._resetTamperState();
  guard.setSwitch('approval', true);
  assert.equal(guard.isOff('approval'), true);
  guard.setSwitch('approval', false);
  assert.equal(guard.isOff('approval'), false);
  guard.setSwitch('approval', true);
  assert.equal(guard.isOff('approval'), true, 'the counter, not the clock, orders markers');
  guard.setSwitch('approval', false);
});

/* ------------------------------------------------------- child environment */

test('the guard secret never reaches a child process', () => {
  const previous = process.env.COMPUTER_USE_GUARD_SECRET;
  process.env.COMPUTER_USE_GUARD_SECRET = 'super-secret';
  process.env.COMPUTER_USE_GUARD_ALLOW_PLAIN = '1';
  try {
    const env = childEnv({ EXTRA: 'kept' });
    assert.equal(env.COMPUTER_USE_GUARD_SECRET, undefined);
    assert.equal(env.COMPUTER_USE_GUARD_ALLOW_PLAIN, undefined);
    assert.equal(env.EXTRA, 'kept');
    // The variable is spelled `Path` on Windows and `PATH` elsewhere.
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path');
    assert.ok(pathKey, 'PATH is inherited');
    assert.equal(env[pathKey], process.env[pathKey], 'everything else is inherited');
  } finally {
    if (previous === undefined) delete process.env.COMPUTER_USE_GUARD_SECRET;
    else process.env.COMPUTER_USE_GUARD_SECRET = previous;
    delete process.env.COMPUTER_USE_GUARD_ALLOW_PLAIN;
  }
});

/* ------------------------------------------------- remember + gate behaviour */

test('"remember this session" is keyed by the action, not just the window', () => {
  _resetSessionApprovals();
  const target = { process: 'WeChat', title: 'WeChat' };
  rememberSession('click_element', target, { name: '发送' });
  assert.equal(isSessionApproved('click_element', target, { name: '发送' }), true);
  assert.equal(isSessionApproved('click_element', target, { name: '删除全部' }), false, 'a different control is not pre-approved');
  assert.equal(isSessionApproved('type_text', target, { text: 'hi' }), false, 'a different tool is not pre-approved');
  assert.equal(approvalKey('click', target, { x: 10, y: 20 }), 'click|WeChat|WeChat|10,20');
  _resetSessionApprovals();
});

test('a second approval call is refused while a dialog is open', () => {
  const saved = { active: gate.active, open: gate.open, action: gate.action, target: gate.target, since: gate.since };
  Object.assign(gate, { active: true, open: 1, action: 'click', target: 'WeChat', since: Date.now() });
  try {
    const busy = approvalBusy('click');
    assert.equal(busy.isError, true);
    const body = JSON.parse(busy.content[0].text);
    assert.equal(body.refused_by_approval_gate, true);
    assert.match(body.reason, /only one is shown at a time/);

    // and the ordinary lock still refuses input tools while it is open
    assert.equal(blockedWhileApprovalPending('key').isError, true);
    assert.equal(blockedWhileApprovalPending('screenshot'), null);
  } finally {
    Object.assign(gate, saved);
  }
});
