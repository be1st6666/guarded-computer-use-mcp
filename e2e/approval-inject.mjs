/**
 * End-to-end test for the approval gate's injected-input filter.
 *
 * Threat: the MCP server blocks on the dialog, but tool calls are async, so a
 * parallel `key("alt+a")` or `click(x, y)` on the Allow button used to answer
 * the prompt. approval.ps1 -BlockInjected 1 installs a low-level hook and
 * swallows every event carrying LLKHF_INJECTED / LLMHF_INJECTED.
 *
 * This test drives the real desktop: it shows the real dialog and injects real
 * input through this server's own host.ps1, exactly like a hostile tool call
 * would. It therefore needs an interactive session — it is skipped when CI=1.
 *
 *   node e2e/approval-inject.mjs
 *
 * Pass criteria:
 *   * the dialog reports injected-input=on
 *   * Alt+A sent with SendInput does NOT allow it (process keeps waiting)
 *   * an injected left click on Allow does NOT allow it
 *   * the dialog ends with exit code 2 (timeout -> auto-deny)
 *   * the dialog counted the ignored injections
 */
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../src/paths.js';
import { host } from '../src/host.js';

const TIMEOUT_MS = 6000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Posts window messages at the live dialog: BM_CLICK on the real Allow button
 * and a posted Alt+A to the form. Neither produces an input event, so the
 * low-level hooks cannot see them — this is the attack the dialog must survive
 * by demanding a *physical* event.
 */
const MESSAGE_ATTACK_PS1 = String.raw`
param([int]$TargetPid)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class MsgAttack {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  public static IntPtr Form = IntPtr.Zero;
  public static IntPtr Button = IntPtr.Zero;
  public static string ButtonText = "";
  public static void Find(uint pid) {
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      uint wp; GetWindowThreadProcessId(h, out wp);
      if (wp != pid) return true;
      StringBuilder t = new StringBuilder(256); GetWindowText(h, t, 256);
      if (t.Length == 0) return true;
      Form = h; return false;
    }, IntPtr.Zero);
    if (Form == IntPtr.Zero) return;
    EnumChildWindows(Form, delegate(IntPtr h, IntPtr p) {
      StringBuilder c = new StringBuilder(256); GetClassName(h, c, 256);
      if (c.ToString().StartsWith("WindowsForms10.Button")) {
        StringBuilder t = new StringBuilder(256); GetWindowText(h, t, 256);
        if (Button == IntPtr.Zero) { Button = h; ButtonText = t.ToString(); }
        if (t.ToString().Contains("(&A)") || t.ToString().Contains("\u5141\u8bb8")) { Button = h; ButtonText = t.ToString(); return false; }
      }
      return true;
    }, IntPtr.Zero);
  }
}
'@
[MsgAttack]::Find([uint32]$TargetPid)
if ([MsgAttack]::Form -eq [IntPtr]::Zero) { Write-Output 'NO_FORM'; exit 1 }
Write-Output ("form=" + [MsgAttack]::Form + " button=[" + [MsgAttack]::ButtonText + "]")
if ([MsgAttack]::Button -ne [IntPtr]::Zero) {
  [void][MsgAttack]::PostMessage([MsgAttack]::Button, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
  Write-Output 'posted BM_CLICK'
}
[void][MsgAttack]::PostMessage([MsgAttack]::Form, 0x0104, [IntPtr]0x12, [IntPtr]::Zero)
[void][MsgAttack]::PostMessage([MsgAttack]::Form, 0x0104, [IntPtr]0x41, [IntPtr]::Zero)
Write-Output 'posted WM_SYSKEYDOWN alt+a'
`;

if (process.env.CI === '1' || process.env.CI === 'true') {
  console.log('SKIP approval-inject: needs an interactive desktop (CI=1)');
  process.exit(0);
}

const script = path.join(ROOT, 'approval.ps1');
const shell = process.env.COMPUTER_USE_SHELL || 'pwsh';

// Warm the PowerShell host first: the first call pays the C# compile cost and
// would otherwise eat into the dialog's countdown.
await host.call('ping', {});

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`);
  if (!ok) failures++;
};

const child = spawn(shell, [
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
  '-Action', 'click', '-Target', '(automated injection test)',
  '-Detail', 'x=10,  y=10', '-Reason', 'security regression test',
  '-TimeoutMs', String(TIMEOUT_MS), '-BlockInjected', '1',
], { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });

let out = '';
let err = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { err += d; });

const exited = new Promise((resolve) => {
  child.on('exit', (code) => resolve(code));
  child.on('error', (e) => { err += String(e); resolve(null); });
});

try {
  await sleep(1800);                                   // let the dialog appear
  check(/injected-input=on/.test(out),
    'dialog installed the injected-input filter',
    (out.match(/injected-input=(\w+)/) || [])[1] ?? 'no status line');

  // 1. The classic bypass: a parallel tool call pressing the Allow mnemonic.
  await host.call('key', { combo: 'alt+a' });
  await sleep(700);
  check(child.exitCode === null, 'injected Alt+A did not answer the dialog',
    child.exitCode === null ? 'still waiting' : `exited early with ${child.exitCode}`);

  // 2. The mouse path: an injected click on the Allow button. Its label follows
  //    the OS language, so match both and fall back to reporting what UIA saw.
  let clicked = 'Allow button not found (keyboard path only)';
  try {
    const found = await host.call('find_elements', { control_type: 'button', window: 'computer-use', max: 10 });
    const buttons = found?.elements ?? [];
    const el = buttons.find((e) => /允许|allow/i.test(e.name ?? '')) ?? buttons[buttons.length - 1];
    if (el && Array.isArray(el.center)) {
      await host.call('click', { x: el.center[0], y: el.center[1], button: 'left', count: 1 });
      clicked = `"${el.name}" @ ${el.center.join(',')}`;
    } else {
      clicked = `no buttons seen: ${JSON.stringify(buttons.map((b) => b.name))}`;
    }
  } catch (e) {
    clicked = `lookup failed: ${e.message}`;
  }
  await sleep(700);
  check(child.exitCode === null && /@/.test(clicked),
    'injected click on Allow did not answer the dialog', clicked);

  // 3. The message path: injected input is not the only way to activate a
  //    WinForms button. PostMessage(BM_CLICK) to the real Allow button, and a
  //    posted Alt+A to the form, produce no input event at all — the hook never
  //    sees them. The dialog must refuse to treat them as a human decision.
  const attack = path.join(os.tmpdir(), `gcu-msg-attack-${process.pid}.ps1`);
  writeFileSync(attack, MESSAGE_ATTACK_PS1);
  const atk = spawnSync(
    shell,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', attack, '-TargetPid', String(child.pid)],
    { encoding: 'utf8', windowsHide: true },
  );
  rmSync(attack, { force: true });
  const atkOut = `${atk.stdout ?? ''}${atk.stderr ?? ''}`.trim();
  await sleep(900);
  check(child.exitCode === null, 'posted BM_CLICK / WM_SYSKEYDOWN did not answer the dialog',
    child.exitCode === null ? atkOut.split('\n').slice(0, 3).join(' | ') : `exited early with ${child.exitCode}`);
  check(/ignored-non-physical-allow/.test(out),
    'the dialog logged the non-physical allow trigger as ignored',
    /posted BM_CLICK/.test(atkOut) ? 'BM_CLICK was delivered' : `message attack output: ${atkOut.slice(0, 120)}`);

  const code = await Promise.race([exited, sleep(TIMEOUT_MS + 6000).then(() => 'hung')]);
  if (code === 'hung') {
    check(false, 'dialog exits on timeout', 'still running — killing it');
    child.kill();
  } else {
    check(code === 2, 'dialog auto-denied on timeout (exit 2)', `exit code ${code}`);
  }

  const swallowed = Number((out.match(/injected-swallowed=(\d+)/) || [])[1] ?? 0);
  check(swallowed >= 2, 'dialog counted the ignored injections', `${swallowed} swallowed`);
  if (err.trim()) console.log('--- dialog stderr ---\n' + err.trim());
} finally {
  if (child.exitCode === null) child.kill();
  host.dispose();
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
