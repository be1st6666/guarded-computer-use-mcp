/**
 * Approval gate — the human-in-the-loop dialog, and the lock that stops the
 * dialog from being answered by the very agent it is asking.
 *
 * Threat this closes (found while hardening, 2026-09-15):
 *
 *   server.registerTool handlers are async. `requestApproval()` therefore
 *   suspends the call that triggered it while the dialog is on screen, and the
 *   MCP client is free to dispatch *another* tool call in the meantime — which
 *   is exactly what a model doing parallel tool calls does. `key("alt+a")`,
 *   `click(x, y)` on the Allow button, or `click_element(name: "Allow")` would
 *   then answer the prompt. The README's claim that "only a real human click
 *   can proceed" was false as written.
 *
 * Three independent defences now:
 *   1. `gate.active` / `gate.open` — while a dialog is open, every tool that
 *      injects input or changes the foreground is refused (see
 *      GATED_WHILE_DIALOG). The caller re-checks it after every await, including
 *      once per batch step. Only one dialog is shown at a time, so the lock
 *      cannot lift while a second prompt is still on screen.
 *   2. The allow decision is taken from approval.ps1's low-level input hooks,
 *      which only fire for *physical* input (approval.ps1 -BlockInjected). The
 *      WinForms button refuses to act on anything else, so `SendInput` from any
 *      tool, a posted BM_CLICK / WM_KEYDOWN, and a UIAutomation InvokePattern are
 *      all ignored — and counted on the dialog.
 *   3. Every refusal is audited, so an attempt to answer the dialog leaves a
 *      record rather than passing silently.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT } from './paths.js';
import { SHELL_CANDIDATES, psFileArgs, childEnv } from './shell.js';
import { GATED_WHILE_DIALOG, getPolicy, physicalInputRequired } from './policy.js';

export const APPROVAL_SCRIPT = path.join(ROOT, 'approval.ps1');

/** Live state of the gate. Exported so tests can drive it directly. */
export const gate = {
  active: false,
  action: null,
  target: null,
  since: 0,
  /** How the dialog's injected-input filter reported itself: on/off/unavailable. */
  lastFilter: null,
  /** Number of dialogs shown since start — useful in the startup audit record. */
  shown: 0,
  /** Dialogs currently open. The lock holds until this reaches zero. */
  open: 0,
};

export function gateActive() {
  return gate.active;
}

/**
 * Refusal result for a tool call that arrived while a dialog is waiting.
 * @returns {null|object} MCP error result, or null when the call may proceed
 */
export function blockedWhileApprovalPending(name) {
  if (!gate.active) return null;
  if (!GATED_WHILE_DIALOG.has(name)) return null;
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            refused_by_approval_gate: true,
            reason:
              'an approval dialog is waiting for a human decision — input-injecting tools are ' +
              'refused until it is answered',
            why: "a parallel call could otherwise answer the dialog on the user's behalf",
            pending_action: gate.action,
            pending_target: gate.target,
            pending_since: new Date(gate.since).toISOString(),
          },
          null,
          2,
        ),
      },
    ],
  };
}

/* ---------------------------------------------------- per-session "remember" */

const sessionApprovals = new Set();

/**
 * Key for "remember this target for this session".
 *
 * It carries the action's own identity, not just the window: remembering a
 * `click_element(name: "Send")` must not pre-approve a later
 * `click_element(name: "Delete")` in the same window.
 */
export const approvalKey = (name, target, args) => {
  const base = `${name}|${target?.process ?? ''}|${target?.title ?? ''}`;
  if (name === 'click_element') {
    return `${base}|${args?.name ?? ''}|${args?.automation_id ?? ''}|${args?.index ?? 0}`;
  }
  if (typeof args?.x === 'number' && typeof args?.y === 'number') return `${base}|${args.x},${args.y}`;
  return base;
};
export const isSessionApproved = (name, target, args) => sessionApprovals.has(approvalKey(name, target, args));
export const rememberSession = (name, target, args) => sessionApprovals.add(approvalKey(name, target, args));
export function _resetSessionApprovals() {
  sessionApprovals.clear();
}

/** Refusal for an approval-requiring call that arrived while a dialog is open. */
export function approvalBusy(name) {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            refused_by_approval_gate: true,
            reason: 'another approval dialog is already open — only one is shown at a time',
            why: 'the gate lock must not lift while any dialog is still unanswered',
            action: name,
          },
          null,
          2,
        ),
      },
    ],
  };
}

/* --------------------------------------------------------------- the dialog */

function spawnApproval(shell, params, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (code) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(code);
      }
    };
    let ps;
    try {
      // windowsHide MUST be false: it maps to STARTUPINFO.wShowWindow = SW_HIDE,
      // which hides the dialog itself (the script still runs and times out, so
      // the failure looks like "user never answered").
      ps = spawn(shell, psFileArgs(APPROVAL_SCRIPT, params), {
        windowsHide: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnv(),
      });
    } catch {
      return resolve(3);
    }
    ps.stdout.setEncoding('utf8');
    ps.stderr.setEncoding('utf8');
    ps.stdout.on('data', (d) => {
      const m = /injected-input=(\w+)/.exec(d);
      if (m) gate.lastFilter = m[1];
      process.stderr.write('[approval] ' + d);
    });
    ps.stderr.on('data', (d) => process.stderr.write('[approval!] ' + d));
    const timer = setTimeout(() => {
      try {
        ps.kill();
      } catch {
        /* ignore */
      }
      finish(3);
    }, timeoutMs + 10000);
    ps.on('error', () => finish(3));
    ps.on('exit', (code) => finish(code));
  });
}

/**
 * Show the dialog and wait for a real decision. Sets/clears the gate lock, so
 * every path out of here (including a throw) re-opens input tools.
 *
 * Only one dialog is shown at a time: a second approval-requiring call that gets
 * this far (it passed the early gate checks before the first dialog opened) is
 * refused with code 5 instead of stacking a second dialog. Stacking was a real
 * hole — as soon as either dialog closed, the lock lifted while the other was
 * still on screen.
 *
 * @returns {Promise<number>} 0 allow · 1 deny · 2 timeout · 3 unavailable · 4 allow+remember · 5 busy
 */
export async function requestApproval(name, args, check, target, { describeTarget, describeArgs }) {
  if (gate.open > 0) return 5;

  const timeoutMs = getPolicy().approval?.timeout_ms ?? 30000;
  const params = [
    '-Action',
    String(name),
    '-Target',
    describeTarget(target),
    '-Detail',
    describeArgs(args),
    '-Reason',
    String(check.reason ?? ''),
    '-TimeoutMs',
    String(timeoutMs),
    '-BlockInjected',
    physicalInputRequired() ? '1' : '0',
  ];

  gate.open++;
  gate.active = true;
  gate.action = name;
  gate.target = describeTarget(target);
  gate.since = Date.now();
  gate.shown++;
  gate.lastFilter = null;

  try {
    for (const shell of SHELL_CANDIDATES) {
      const code = await spawnApproval(shell, params, timeoutMs);
      if (code !== 3) return code; // 0 allow / 1 deny / 2 timeout / 4 allow + remember
    }
    return 3; // every shell failed to start
  } finally {
    gate.open = Math.max(0, gate.open - 1);
    gate.active = gate.open > 0; // the lock lifts only when the last dialog is answered
    if (!gate.active) {
      gate.action = null;
      gate.target = null;
    }
  }
}

/** MCP error result for a refusal that came from the dialog. */
export function approvalDenied(name, args, check, code) {
  const outcome =
    code === 2 ? 'timed out (auto-denied)' : code === 3 ? 'approval dialog unavailable' : 'the user denied it';
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            denied_by_approval: true,
            outcome,
            action: name,
            arguments: args,
            reason: check.reason,
          },
          null,
          2,
        ),
      },
    ],
  };
}
