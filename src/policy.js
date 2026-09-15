/**
 * Policy layer — deny lists, allow list, rate limit, and the "does this action
 * need a human?" decision.
 *
 * Kept free of I/O except reading policy.json, so the whole decision surface is
 * unit-testable: see test/policy.test.mjs.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.js';
import * as guard from './guard.js';

export const POLICY_PATH = process.env.COMPUTER_USE_POLICY ?? path.join(ROOT, 'policy.json');

/** Active policy file — tests and embedders can point it elsewhere. */
let activePath = POLICY_PATH;
export const policyPath = () => activePath;
export function configurePolicyPath(p) {
  activePath = p ? path.resolve(p) : POLICY_PATH;
  return activePath;
}

export const DEFAULT_POLICY = {
  deny_processes: [
    'keepass',
    'keepassxc',
    '1password',
    'bitwarden',
    'lastpass',
    'dashlane',
    'nordpass',
    'keeper',
    'enpass',
    'authenticator',
    'windowssecurity',
    'metamask',
    'exodus',
    'ledgerlive',
    'trezor',
    'electrum',
    'regedit',
    'diskmgmt',
    'diskpart',
    'gpedit',
    'compmgmt',
    'certmgr',
    'mmc',
  ],
  deny_window_titles: [
    '密码',
    'password',
    '凭据',
    'credential',
    '助记词',
    'seed phrase',
    '银行',
    'bank',
    '支付',
    'pay',
    '钱包',
    'wallet',
    '转账',
    'transfer',
    '两步验证',
    '2fa',
    'otp',
    '验证码',
    '用户账户控制',
    'user account control',
  ],
  approval_processes: [
    'weixin',
    'wechat',
    'qq',
    'telegram',
    'discord',
    'whatsapp',
    'signal',
    'slack',
    'teams',
    'dingtalk',
    '飞书',
    'feishu',
    'lark',
    'outlook',
    'thunderbird',
    'foxmail',
    'mstsc',
    'teamviewer',
    'anydesk',
    'todesk',
    'sunflower',
    'vnc',
    'rustdesk',
  ],
  approval_window_titles: ['发送', 'send', '远程桌面', 'remote desktop', '远程控制', 'remote control'],
  allow_processes: [], // non-empty switches to allow-list mode
  max_actions_per_minute: 120,
  audit: true,
  approval: {
    enabled: true,
    timeout_ms: 30000,
    /**
     * Ignore keystrokes and clicks that carry the Windows "injected" flag, so
     * SendInput from any automation tool cannot answer the dialog. Falls back
     * to normal behaviour (and says so on the dialog) if the hook cannot be
     * installed. `.physical-off` turns it off too.
     */
    require_physical_input: true,
  },
};

let policy = structuredClone(DEFAULT_POLICY);
let loadError = null;

/**
 * Merge a user policy over the defaults.
 *
 * Lists and scalars replace wholesale (a user `deny_processes` should be *the*
 * list), but the `approval` block is merged key by key: a policy.json that only
 * says `"approval": { "enabled": false }` must not silently drop `timeout_ms`
 * and `require_physical_input`.
 */
export function mergePolicy(raw) {
  const merged = { ...structuredClone(DEFAULT_POLICY), ...(raw ?? {}) };
  const approval = raw?.approval;
  merged.approval =
    approval === false
      ? { ...structuredClone(DEFAULT_POLICY.approval), enabled: false }
      : { ...structuredClone(DEFAULT_POLICY.approval), ...(approval && typeof approval === 'object' ? approval : {}) };
  return merged;
}

export function reloadPolicy() {
  loadError = null;
  try {
    if (!existsSync(activePath)) {
      policy = structuredClone(DEFAULT_POLICY);
      return getPolicy();
    }
    const raw = JSON.parse(readFileSync(activePath, 'utf8'));
    policy = mergePolicy(raw);
    process.stderr.write(`[computer-use] policy loaded: ${activePath}\n`);
  } catch (e) {
    // A broken policy must never mean "no policy": fall back to the defaults.
    loadError = e.message;
    policy = structuredClone(DEFAULT_POLICY);
    process.stderr.write(`[computer-use] policy ignored (${e.message}), using defaults\n`);
  }
  return getPolicy();
}

export function getPolicy() {
  return policy;
}
export function policyLoadError() {
  return loadError;
}

/* ------------------------------------------------------------- switches */

/** Master switch: off means the deny lists and the rate limit are skipped. */
export function guardEnabled() {
  return !guard.isOff('guard');
}

/** The approval dialog: off (or policy.approval.enabled=false) returns pending. */
export function approvalEnabled() {
  if (guard.isOff('approval')) return false;
  return getPolicy().approval?.enabled !== false;
}

/** Require physical input in the dialog (see DEFAULT_POLICY.approval). */
export function physicalInputRequired() {
  if (guard.isOff('physical')) return false;
  return getPolicy().approval?.require_physical_input !== false;
}

export function auditEnabled() {
  if (guard.isOff('audit')) return false;
  return getPolicy().audit !== false;
}

/* ---------------------------------------------------------- action sets */

/** Tools that produce side effects on the real desktop. */
export const MUTATING = new Set([
  'mouse_move',
  'click',
  'drag',
  'scroll',
  'type_text',
  'key',
  'hold_key',
  'clipboard_write',
  'launch_app',
  'click_element',
]);

/**
 * Tools refused while an approval dialog is open.
 *
 * This is the fix for the self-injection hole: the dialog blocks the server,
 * but tool calls are async, so a second call arriving in parallel used to run
 * while the dialog was on screen — `key("alt+a")` or a click on the Allow
 * button would answer the very prompt that was supposed to require a human.
 * Everything that injects input or moves the foreground is now refused until
 * the dialog is answered.
 */
export const GATED_WHILE_DIALOG = new Set([...MUTATING, 'activate_window', 'batch']);

/* ------------------------------------------------------------ matching */

export function matchesAny(haystack, needles) {
  const h = String(haystack ?? '').toLowerCase();
  return (needles ?? []).find((n) => h.includes(String(n).toLowerCase())) ?? null;
}

export function denied(reason, detail, hint) {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({ blocked_by_policy: true, reason, detail, hint }, null, 2),
      },
    ],
  };
}

/* --------------------------------------------------------- rate limiting */

const rateLog = [];
export function _resetRateLimit() {
  rateLog.length = 0;
}

export function rateExceeded(now = Date.now()) {
  while (rateLog.length && now - rateLog[0] > 60000) rateLog.shift();
  if (rateLog.length >= (getPolicy().max_actions_per_minute ?? 120)) return true;
  rateLog.push(now);
  return false;
}

/* ------------------------------------------------------------ the guard */

/**
 * Hard refusal. Runs before approval: a denied target never reaches the dialog.
 * @returns {null|object} an MCP error result, or null when the action may run
 */
export function policyGuard(name, args, target) {
  if (!MUTATING.has(name)) return null;
  if (!guardEnabled()) return null; // master switch off: skip lists + limit

  if (target && target.found !== false) {
    const proc = target.process ?? '';
    const title = target.title ?? '';

    const badProc = matchesAny(proc, getPolicy().deny_processes);
    if (badProc) {
      return denied(
        'target process is on the deny list',
        { process: proc, title, matched: badProc },
        `Edit ${policyPath()} to allow it.`,
      );
    }
    const badTitle = matchesAny(title, getPolicy().deny_window_titles);
    if (badTitle) {
      return denied(
        'target window title looks sensitive',
        { process: proc, title, matched: badTitle },
        `Edit ${policyPath()} to allow it.`,
      );
    }
    const allow = getPolicy().allow_processes ?? [];
    if (allow.length && !matchesAny(proc, allow)) {
      return denied(
        'target process is not on the allow list',
        { process: proc, title, allow },
        `Edit ${policyPath()} to allow it.`,
      );
    }
  }

  if (rateExceeded()) {
    return denied(
      'rate limit exceeded',
      { max_actions_per_minute: getPolicy().max_actions_per_minute },
      'Wait a minute or raise the limit.',
    );
  }

  return null;
}

/* ------------------------------------------------------- safety patterns */

export const DANGER_KEY_COMBOS = [
  /alt\+f4/i,
  /ctrl\+w/i,
  /^win\+/i,
  /ctrl\+alt\+del/i,
  /ctrl\+shift\+esc/i,
  /shift\+delete/i,
  /^delete$/i,
  /^del$/i,
];

export const DANGER_NAMES = [
  /关闭|删除|卸载|格式化|关机|重启|注销|清空|移除|发送|提交|支付|确认|同意/,
  /\b(close|delete|remove|uninstall|shutdown|restart|format|send|submit|pay|confirm|discard|empty|trash)\b/i,
];

/** Destructive-looking action patterns, independent of the target window. */
export function safetyCheck(name, args) {
  if (args?.confirm === true) return null; // explicitly confirmed by the caller

  if (name === 'key' || name === 'hold_key') {
    const combo = String(args?.combo ?? args?.key ?? '');
    for (const re of DANGER_KEY_COMBOS) {
      if (re.test(combo)) {
        return { reason: `key combo "${combo}" is destructive`, pattern: String(re), source: 'pattern' };
      }
    }
  }

  if (name === 'click_element') {
    const target = `${args?.name ?? ''} ${args?.automation_id ?? ''} ${args?.window ?? ''}`;
    for (const re of DANGER_NAMES) {
      if (re.test(target)) {
        return { reason: `target looks destructive: "${target.trim()}"`, pattern: String(re), source: 'pattern' };
      }
    }
  }

  if (name === 'click' && args?.button === 'right') {
    return {
      reason: 'right-click opens a context menu with destructive entries',
      pattern: 'right-click',
      source: 'pattern',
    };
  }

  return null;
}

/**
 * Does this action need a human? Two independent sources:
 *   1. the destructive-looking patterns above (source: 'pattern')
 *   2. the target being on an approval list — messaging, mail, remote desktop
 *      (source: 'list'); there a single stray click is irreversible
 */
export function needsApproval(name, args, target) {
  const patternCheck = safetyCheck(name, args);
  if (patternCheck) return patternCheck;

  if (!MUTATING.has(name)) return null;
  if (!target || target.found === false) return null;

  const proc = matchesAny(target.process, getPolicy().approval_processes ?? []);
  if (proc) {
    return { reason: `process "${target.process}" always requires approval`, pattern: proc, source: 'list' };
  }
  const title = matchesAny(target.title, getPolicy().approval_window_titles ?? []);
  if (title) {
    return { reason: `window title "${target.title}" always requires approval`, pattern: title, source: 'list' };
  }
  return null;
}

/**
 * Answer used when the action needs approval but no dialog was shown (the gate
 * is switched off, or the dialog could not start). Never an error by itself:
 * the caller may still re-issue with confirm:true — except for approval-list
 * targets, where confirm is deliberately not enough.
 */
export function pendingCheck(name, args, check, why = 'disabled') {
  const listTarget = check?.source === 'list';
  const unknownTarget = check?.source === 'unknown';
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            pending_safety_check: true,
            approval_gate: why, // 'disabled' | 'unavailable'
            action: name,
            arguments: args,
            reason: check.reason,
            matched: check.pattern,
            how_to_proceed: unknownTarget
              ? 'The window this action would land on could not be resolved, so the deny lists could ' +
                'not be applied. Re-issue with confirm: true only if you know what is under the ' +
                'cursor / what currently has focus.'
              : listTarget
                ? 'Not proceeding: this target is on the always-ask list, so confirm:true does not ' +
                  'override it. Turn the approval gate back on (guard-panel.cmd) or do it yourself.'
                : 'Re-issue the same call with confirm: true after the user agrees.',
          },
          null,
          2,
        ),
      },
    ],
  };
}
