/**
 * Unit tests for src/approval.js — the gate lock that refuses parallel tool
 * calls while an approval dialog is on screen.
 *
 * This is the regression test for the fixed bypass: the dialog blocks the
 * server, but tool calls are async, so a second (parallel) call used to run
 * while the dialog waited — `key("alt+a")` or `click_element("Allow")` could
 * answer the very prompt that was supposed to need a human.
 *
 * These tests never call requestApproval (that would spawn the real dialog).
 * They drive the exported `gate` object directly and always restore it,
 * including when an assertion fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GATED_WHILE_DIALOG } from '../src/policy.js';
import {
  gate, gateActive, blockedWhileApprovalPending, approvalKey, isSessionApproved,
  rememberSession, _resetSessionApprovals,
} from '../src/approval.js';

const snapshotGate = () => ({ ...gate });
function restoreGate(snap) {
  gate.active = snap.active;
  gate.action = snap.action;
  gate.target = snap.target;
  gate.since = snap.since;
  gate.lastFilter = snap.lastFilter;
  gate.shown = snap.shown;
}

test('with gate.active=false every tool name returns null', () => {
  const snap = snapshotGate();
  try {
    gate.active = false;
    const names = [...GATED_WHILE_DIALOG, 'screenshot', 'list_windows', 'find_elements', 'nonsense'];
    for (const name of names) {
      assert.equal(blockedWhileApprovalPending(name), null, `${name} must not be blocked when no dialog is open`);
    }
    assert.equal(gateActive(), false);
  } finally { restoreGate(snap); }
});

test('while a dialog is open every input-injecting tool is refused', () => {
  const snap = snapshotGate();
  try {
    const since = Date.now() - 5000;
    gate.active = true;
    gate.action = 'type_text';
    gate.target = 'notepad (Untitled)';
    gate.since = since;

    const names = [
      'key', 'click', 'type_text', 'mouse_move', 'drag', 'scroll', 'hold_key',
      'click_element', 'clipboard_write', 'launch_app', 'activate_window', 'batch',
    ];
    for (const name of names) {
      assert.equal(GATED_WHILE_DIALOG.has(name), true, `${name} is expected to be gated`);
      const r = blockedWhileApprovalPending(name);
      assert.notEqual(r, null, `${name} must be refused while the dialog waits`);
      assert.equal(r.isError, true);
      assert.equal(r.content.length, 1);
      assert.equal(r.content[0].type, 'text');

      const body = JSON.parse(r.content[0].text);
      assert.equal(body.refused_by_approval_gate, true, `${name} payload flag`);
      assert.equal(body.pending_action, 'type_text');
      assert.equal(body.pending_target, 'notepad (Untitled)');
      assert.equal(body.pending_since, new Date(since).toISOString());
      assert.match(body.why, /parallel call/);
      assert.match(body.reason, /approval dialog is waiting for a human decision/);
    }
    assert.equal(gateActive(), true);
  } finally { restoreGate(snap); }
});

test('while a dialog is open read-only tools still return null', () => {
  const snap = snapshotGate();
  try {
    gate.active = true;
    gate.action = 'click';
    gate.target = 'WeChat';
    gate.since = Date.now();

    for (const name of ['screenshot', 'screen_hash', 'list_windows', 'find_elements']) {
      assert.equal(GATED_WHILE_DIALOG.has(name), false, `${name} must not be in GATED_WHILE_DIALOG`);
      assert.equal(blockedWhileApprovalPending(name), null, `${name} must keep working during a dialog`);
    }
    // …but an input-injecting tool on the same gate is refused, proving the gate is on.
    assert.notEqual(blockedWhileApprovalPending('click'), null);
  } finally { restoreGate(snap); }
});

test('the refusal payload reports the live pending action and ISO timestamp', () => {
  const snap = snapshotGate();
  try {
    const since = Date.now() - 1234;
    gate.active = true;
    gate.action = 'clipboard_write';
    gate.target = 'chrome (mail)';
    gate.since = since;

    const body = JSON.parse(blockedWhileApprovalPending('batch').content[0].text);
    assert.equal(body.pending_action, 'clipboard_write');
    assert.equal(body.pending_target, 'chrome (mail)');
    assert.equal(body.pending_since, new Date(since).toISOString());
    assert.match(body.pending_since, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(Object.keys(body).sort().join(','), [
      'pending_action', 'pending_since', 'pending_target', 'reason', 'refused_by_approval_gate', 'why',
    ].sort().join(','));
  } finally { restoreGate(snap); }
});

test('unblocking the gate re-opens input tools immediately', () => {
  const snap = snapshotGate();
  try {
    gate.active = true;
    gate.action = 'click';
    gate.since = Date.now();
    assert.equal(blockedWhileApprovalPending('key').isError, true);

    gate.active = false;
    assert.equal(blockedWhileApprovalPending('key'), null);
    assert.equal(blockedWhileApprovalPending('batch'), null);
    assert.equal(gateActive(), false);
  } finally { restoreGate(snap); }
});

test('the approval key is name|process|title and drives the session remember set', () => {
  const snap = snapshotGate();
  try {
    _resetSessionApprovals();
    const notepad = { process: 'notepad', title: 'Untitled' };
    const wechat = { process: 'WeChat', title: 'WeChat' };
    const wechatNoTitle = { process: 'WeChat' };

    assert.equal(approvalKey('click', notepad), 'click|notepad|Untitled');
    assert.equal(approvalKey('click', undefined), 'click||');
    assert.equal(approvalKey('type_text', wechatNoTitle), 'type_text|WeChat|');

    assert.equal(isSessionApproved('click', notepad), false);
    assert.equal(isSessionApproved('click', wechat), false);

    rememberSession('click', wechat);
    assert.equal(isSessionApproved('click', wechat), true);
    assert.equal(isSessionApproved('click', notepad), false, 'a different target is not approved');
    assert.equal(isSessionApproved('key', wechat), false, 'a different action is not approved');
    assert.equal(isSessionApproved('type_text', wechatNoTitle), false, 'the title is part of the key');

    _resetSessionApprovals();
    assert.equal(isSessionApproved('click', wechat), false, 'reset clears the session approvals');

    // A remembered approval is stored under the exact key, not the object identity.
    rememberSession('click', { process: 'WeChat', title: 'WeChat' });
    assert.equal(isSessionApproved('click', { process: 'WeChat', title: 'WeChat' }), true);
  } finally {
    _resetSessionApprovals();
    restoreGate(snap);
  }
});
