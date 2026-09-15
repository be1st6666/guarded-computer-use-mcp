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
 * Two independent defences now:
 *   1. `gate.active` — while a dialog is open, every tool that injects input or
 *      changes the foreground is refused (see GATED_WHILE_DIALOG).
 *   2. The dialog itself ignores keystrokes and clicks that carry the Windows
 *      LLKHF_INJECTED / LLMHF_INJECTED flag (approval.ps1 -BlockInjected), so
 *      SendInput from *any* tool — another MCP server, a script, this one —
 *      cannot answer it. That check cannot tell a physical key from a synthetic
 *      one for UIAutomation invocations, which is documented in SECURITY.md.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT } from './paths.js';
import { SHELL_CANDIDATES, psFileArgs } from './shell.js';
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
export const approvalKey = (name, target) => `${name}|${target?.process ?? ''}|${target?.title ?? ''}`;
export const isSessionApproved = (name, target) => sessionApprovals.has(approvalKey(name, target));
export const rememberSession = (name, target) => sessionApprovals.add(approvalKey(name, target));
export function _resetSessionApprovals() {
  sessionApprovals.clear();
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
      ps = spawn(shell, psFileArgs(APPROVAL_SCRIPT, params), { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
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
 * @returns {Promise<number>} 0 allow · 1 deny · 2 timeout · 3 unavailable
 */
export async function requestApproval(name, args, check, target, { describeTarget, describeArgs }) {
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

  gate.active = true;
  gate.action = name;
  gate.target = describeTarget(target);
  gate.since = Date.now();
  gate.shown++;
  gate.lastFilter = null;

  try {
    for (const shell of SHELL_CANDIDATES) {
      const code = await spawnApproval(shell, params, timeoutMs);
      if (code === 4) {
        // allow + remember for this session
        rememberSession(name, target);
        return 0;
      }
      if (code !== 3) return code; // 0 allow / 1 deny / 2 timeout
    }
    return 3; // every shell failed to start
  } finally {
    gate.active = false;
    gate.action = null;
    gate.target = null;
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
