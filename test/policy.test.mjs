/**
 * Unit tests for src/policy.js — deny lists, allow list, rate limit and the
 * "does this need a human?" decision surface.
 *
 * `configurePolicyPath()` points every test at a temp policy.json; the project's
 * own policy.json is only ever read (in `before`, to restore the process
 * afterwards). The rate limiter is a module-level array, so each test calls
 * `_resetRateLimit()`.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { tempDir, removeDir, writePolicy, writeText, jsonOf } from './helpers/tmp.mjs';
import { configure as configureGuard } from '../src/guard.js';
import {
  DEFAULT_POLICY, policyPath, configurePolicyPath, reloadPolicy, getPolicy,
  policyLoadError, matchesAny, denied, policyGuard, rateExceeded, _resetRateLimit,
  safetyCheck, needsApproval, pendingCheck, MUTATING, GATED_WHILE_DIALOG,
  guardEnabled, approvalEnabled, auditEnabled, physicalInputRequired,
} from '../src/policy.js';

let originalPath;
let guardDir;

before(() => {
  originalPath = policyPath();
  guardDir = tempDir('policy-guard');
  configureGuard({ dir: guardDir });   // temp guard state: all switches ON
});

after(() => {
  restorePolicy();
  removeDir(guardDir);
});

/** A policy of our own, in a temp dir, activated. */
function usePolicy(object) {
  const dir = tempDir('policy');
  const file = writePolicy(dir, object);
  configurePolicyPath(file);
  reloadPolicy();
  _resetRateLimit();
  return { dir, file };
}

/** Restore whatever policy the process had before this file ran. */
function restorePolicy() {
  configurePolicyPath(originalPath);
  reloadPolicy();
  _resetRateLimit();
}

test('an invalid-JSON policy falls back to DEFAULT_POLICY and records the error', () => {
  const dir = tempDir('policy-bad');
  try {
    const file = writeText(dir, 'policy.json', '{ "deny_processes": ["keepass", }');
    configurePolicyPath(file);
    const p = reloadPolicy();
    _resetRateLimit();

    assert.equal(typeof policyLoadError(), 'string');
    assert.ok(policyLoadError().length > 0);
    assert.deepEqual(p, DEFAULT_POLICY);
    assert.deepEqual(getPolicy().deny_processes, DEFAULT_POLICY.deny_processes);
    assert.equal(getPolicy().max_actions_per_minute, 120);

    // …and a broken policy must still refuse a password manager, not allow it.
    const r = policyGuard('click', { x: 1, y: 1 }, { process: 'KeePassXC', title: 'KeePassXC' });
    assert.equal(r.isError, true);
    assert.equal(jsonOf(r).blocked_by_policy, true);
  } finally {
    restorePolicy();
    removeDir(dir);
  }
});

test('a missing policy file also falls back to defaults (no load error)', () => {
  const dir = tempDir('policy-none');
  try {
    const missing = writePolicy(dir, {});
    removeDir(dir);
    assert.equal(existsSync(missing), false);
    configurePolicyPath(missing);
    const p = reloadPolicy();
    _resetRateLimit();
    assert.equal(policyLoadError(), null);
    assert.deepEqual(p, DEFAULT_POLICY);
  } finally { restorePolicy(); }
});

test('deny_processes matches case-insensitively as a substring and reports the pattern', () => {
  const { dir, file } = usePolicy({ deny_processes: ['keepass'], deny_window_titles: [] });
  try {
    assert.equal(matchesAny('KeePassXC', ['keepass']), 'keepass');
    assert.equal(matchesAny('KEEPASSXC.EXE', ['keepass']), 'keepass');
    assert.equal(matchesAny('notepad', ['keepass']), null);

    const r = policyGuard('click', { x: 1, y: 1 }, { process: 'KeePassXC', title: 'KeePassXC' });
    assert.equal(r.isError, true);
    const body = jsonOf(r);
    assert.equal(body.blocked_by_policy, true);
    assert.equal(body.reason, 'target process is on the deny list');
    assert.equal(body.detail.process, 'KeePassXC');
    assert.equal(body.detail.matched, 'keepass');
    assert.equal(body.hint, `Edit ${file} to allow it.`);

    // A denied target never reaches the rate limiter, so nothing was consumed.
    assert.equal(rateExceeded(0), false);
  } finally { restorePolicy(); removeDir(dir); }
});

test('a deny_window_titles hit (e.g. 输入密码 - Chrome) is refused', () => {
  const { dir } = usePolicy({ deny_processes: [], deny_window_titles: ['密码'] });
  try {
    const r = policyGuard('click', { x: 5, y: 5 }, { process: 'chrome', title: '输入密码 - Chrome' });
    assert.equal(r.isError, true);
    const body = jsonOf(r);
    assert.equal(body.blocked_by_policy, true);
    assert.equal(body.reason, 'target window title looks sensitive');
    assert.equal(body.detail.matched, '密码');
    assert.equal(body.detail.title, '输入密码 - Chrome');
  } finally { restorePolicy(); removeDir(dir); }
});

test('read-only tools are never refused, even against a deny-listed target', () => {
  const { dir } = usePolicy({ deny_processes: ['keepass'], deny_window_titles: ['密码'] });
  try {
    const target = { process: 'KeePassXC', title: '输入密码' };
    for (const name of ['screenshot', 'list_windows', 'screen_hash']) {
      assert.equal(MUTATING.has(name), false, `${name} must not be in MUTATING`);
      assert.equal(policyGuard(name, {}, target), null, `${name} must never be refused`);
    }
    // A mutating tool on the same target is refused, proving the target is hostile.
    assert.equal(policyGuard('click', { x: 1, y: 1 }, target).isError, true);
  } finally { restorePolicy(); removeDir(dir); }
});

test('with a non-empty allow_processes only those processes pass', () => {
  const { dir } = usePolicy({ deny_processes: [], deny_window_titles: [], allow_processes: ['notepad'] });
  try {
    assert.equal(policyGuard('click', { x: 1, y: 1 }, { process: 'notepad', title: 'Untitled' }), null);

    const refused = policyGuard('click', { x: 1, y: 1 }, { process: 'chrome', title: 'New Tab' });
    assert.equal(refused.isError, true);
    const body = jsonOf(refused);
    assert.equal(body.blocked_by_policy, true);
    assert.equal(body.reason, 'target process is not on the allow list');
    assert.deepEqual(body.detail.allow, ['notepad']);

    // targets that were never resolved are not subject to the allow list
    assert.equal(policyGuard('click', { x: 1, y: 1 }, null), null);
    assert.equal(policyGuard('click', { x: 1, y: 1 }, { found: false }), null);
  } finally { restorePolicy(); removeDir(dir); }
});

test('the rate limit refuses the 4th mutating call when max_actions_per_minute is 3', () => {
  const { dir } = usePolicy({ max_actions_per_minute: 3, deny_processes: [], deny_window_titles: [] });
  try {
    assert.equal(getPolicy().max_actions_per_minute, 3);
    for (let i = 1; i <= 3; i++) {
      assert.equal(policyGuard('click', { x: i, y: i }, null), null, `call ${i} should pass`);
    }
    const fourth = policyGuard('click', { x: 4, y: 4 }, null);
    assert.equal(fourth.isError, true);
    const body = jsonOf(fourth);
    assert.equal(body.blocked_by_policy, true);
    assert.equal(body.reason, 'rate limit exceeded');
    assert.equal(body.detail.max_actions_per_minute, 3);
    assert.equal(jsonOf(policyGuard('click', { x: 5, y: 5 }, null)).reason, 'rate limit exceeded');

    _resetRateLimit();
    assert.equal(policyGuard('click', { x: 6, y: 6 }, null), null, 'reset re-opens the window');

    // rateExceeded itself, driven with explicit timestamps (no wall-clock flakiness):
    _resetRateLimit();
    assert.equal(rateExceeded(1000), false);
    assert.equal(rateExceeded(1001), false);
    assert.equal(rateExceeded(1002), false);
    assert.equal(rateExceeded(1003), true, 'the 4th call inside one minute is refused');

    // Fresh window: entries more than 60 s old are evicted, so calls pass again.
    _resetRateLimit();
    assert.equal(rateExceeded(0), false);
    assert.equal(rateExceeded(0), false);
    assert.equal(rateExceeded(0), false);
    assert.equal(rateExceeded(0), true);
    assert.equal(rateExceeded(60001), false, 'calls older than 60 s are evicted');
    assert.equal(rateExceeded(60001), false);
    assert.equal(rateExceeded(60001), false);
    assert.equal(rateExceeded(60001), true);
  } finally { restorePolicy(); removeDir(dir); }
});

test('safetyCheck flags destructive key combos, right-click and destructive element names', () => {
  for (const combo of ['alt+f4', 'ctrl+w', 'win+d']) {
    const r = safetyCheck('key', { combo });
    assert.notEqual(r, null, `${combo} should be flagged`);
    assert.equal(r.source, 'pattern');
    assert.match(r.reason, new RegExp(combo.replace('+', '\\+')));
    assert.match(r.pattern, /^\//);                       // the regex source, as a string
    assert.notEqual(safetyCheck('hold_key', { combo }), null);
  }

  const right = safetyCheck('click', { x: 10, y: 10, button: 'right' });
  assert.equal(right.source, 'pattern');
  assert.equal(right.pattern, 'right-click');

  const del = safetyCheck('click_element', { name: '删除全部' });
  assert.equal(del.source, 'pattern');
  assert.match(del.reason, /删除全部/);

  assert.equal(safetyCheck('click', { x: 1, y: 1, button: 'left' }), null);
  assert.equal(safetyCheck('click_element', { name: 'Save' }), null);
  assert.equal(safetyCheck('key', { combo: 'ctrl+s' }), null);
});

test('safetyCheck returns null when args.confirm === true', () => {
  assert.equal(safetyCheck('key', { combo: 'alt+f4', confirm: true }), null);
  assert.equal(safetyCheck('click', { x: 1, y: 1, button: 'right', confirm: true }), null);
  assert.equal(safetyCheck('click_element', { name: '删除全部', confirm: true }), null);
  assert.notEqual(safetyCheck('key', { combo: 'alt+f4', confirm: 'yes' }), null, 'only boolean true confirms');
});

test('needsApproval returns source:list for an approval-list process and null for read-only tools', () => {
  const { dir } = usePolicy({ approval_processes: ['wechat'], approval_window_titles: [] });
  try {
    const r = needsApproval('click', { x: 1, y: 1 }, { process: 'WeChat', title: 'WeChat' });
    assert.equal(r.source, 'list');
    assert.equal(r.pattern, 'wechat');
    assert.equal(r.reason, 'process "WeChat" always requires approval');

    // case-insensitive substring, like the deny lists
    assert.equal(needsApproval('key', { combo: 'a' }, { process: 'wechat.exe', title: '' }).source, 'list');

    // read-only tools never need approval, whatever the target
    for (const name of ['screenshot', 'list_windows', 'screen_hash']) {
      assert.equal(needsApproval(name, {}, { process: 'WeChat', title: 'WeChat' }), null);
    }
    // unresolved / unrelated targets and harmless mutating actions pass
    assert.equal(needsApproval('click', { x: 1, y: 1 }, null), null);
    assert.equal(needsApproval('click', { x: 1, y: 1 }, { found: false }), null);
    assert.equal(needsApproval('click', { x: 1, y: 1 }, { process: 'notepad', title: 'Untitled' }), null);

    // the pattern check wins when both apply
    const both = needsApproval('key', { combo: 'alt+f4' }, { process: 'WeChat', title: 'WeChat' });
    assert.equal(both.source, 'pattern');
  } finally { restorePolicy(); removeDir(dir); }
});

test('needsApproval still flags destructive patterns when a title is on the approval list', () => {
  const { dir } = usePolicy({ approval_processes: [], approval_window_titles: ['发送'] });
  try {
    const r = needsApproval('click_element', { name: 'Send' }, { process: 'chrome', title: '发送邮件' });
    assert.equal(r.source, 'pattern', 'the destructive name is checked first');
    const byTitle = needsApproval('click_element', { name: 'OK' }, { process: 'chrome', title: '发送邮件' });
    assert.equal(byTitle.source, 'list');
    assert.equal(byTitle.pattern, '发送');
  } finally { restorePolicy(); removeDir(dir); }
});

test("pendingCheck explains that confirm:true will NOT override a source:'list' check", () => {
  const listCheck = { reason: 'process "WeChat" always requires approval', pattern: 'wechat', source: 'list' };
  const r = pendingCheck('click', { x: 1, y: 1 }, listCheck, 'disabled');
  assert.equal(r.isError, undefined, 'pendingCheck is not an error by itself');
  const body = jsonOf(r);
  assert.equal(body.pending_safety_check, true);
  assert.equal(body.approval_gate, 'disabled');
  assert.equal(body.action, 'click');
  assert.deepEqual(body.arguments, { x: 1, y: 1 });
  assert.equal(body.reason, listCheck.reason);
  assert.equal(body.matched, 'wechat');
  assert.match(body.how_to_proceed, /confirm:true does not override it/);
  assert.equal(/Re-issue the same call/.test(body.how_to_proceed), false);

  const patternCheck = { reason: 'key combo "alt+f4" is destructive', pattern: '/alt\\+f4/i', source: 'pattern' };
  const p = jsonOf(pendingCheck('key', { combo: 'alt+f4' }, patternCheck, 'unavailable'));
  assert.equal(p.approval_gate, 'unavailable');
  assert.equal(p.how_to_proceed, 'Re-issue the same call with confirm: true after the user agrees.');
  assert.equal(p.matched, '/alt\\+f4/i');
});

test('MUTATING and GATED_WHILE_DIALOG have the documented membership', () => {
  assert.deepEqual(
    [...MUTATING].sort(),
    ['click', 'click_element', 'clipboard_write', 'drag', 'hold_key', 'key', 'launch_app',
      'mouse_move', 'scroll', 'type_text'],
  );
  for (const name of MUTATING) {
    assert.equal(GATED_WHILE_DIALOG.has(name), true, `${name} must be gated while a dialog is open`);
  }
  assert.equal(GATED_WHILE_DIALOG.has('activate_window'), true);
  assert.equal(GATED_WHILE_DIALOG.has('batch'), true);
  assert.equal(GATED_WHILE_DIALOG.size, MUTATING.size + 2);
  for (const name of ['screenshot', 'screen_hash', 'list_windows', 'find_elements']) {
    assert.equal(GATED_WHILE_DIALOG.has(name), false);
  }
});

test('denied() builds the documented MCP error result', () => {
  const r = denied('why', { a: 1 }, 'hint');
  assert.equal(r.isError, true);
  assert.equal(r.content.length, 1);
  assert.equal(r.content[0].type, 'text');
  assert.deepEqual(JSON.parse(r.content[0].text), {
    blocked_by_policy: true, reason: 'why', detail: { a: 1 }, hint: 'hint',
  });
});

test('the enabled() helpers follow the guard switches', () => {
  assert.equal(guardEnabled(), true);
  assert.equal(approvalEnabled(), true);
  assert.equal(auditEnabled(), true);
  assert.equal(physicalInputRequired(), true);
  assert.equal(policyPath(), originalPath, 'policyPath() points back at the real file');
});

/*
 * Regression: reloadPolicy() used to shallow-merge (`{ ...DEFAULT_POLICY, ...raw }`),
 * so `"approval": { "enabled": false }` dropped timeout_ms and
 * require_physical_input entirely. The approval block is now merged key by key.
 */
test('a partial approval block keeps the other defaults', () => {
  const { dir } = usePolicy({ approval: { enabled: false } });
  try {
    assert.deepEqual(getPolicy().approval, {
      enabled: false,
      timeout_ms: 30000,
      require_physical_input: true,
    });
    assert.equal(approvalEnabled(), false);
    assert.equal(physicalInputRequired(), true, 'disabling the dialog does not disable the filter');
  } finally { restorePolicy(); removeDir(dir); }
});

test('"approval": false is accepted as "dialog off" without losing the block', () => {
  const { dir } = usePolicy({ approval: false });
  try {
    assert.equal(getPolicy().approval.enabled, false);
    assert.equal(getPolicy().approval.timeout_ms, 30000);
    assert.equal(approvalEnabled(), false);
  } finally { restorePolicy(); removeDir(dir); }
});
