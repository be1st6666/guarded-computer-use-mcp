# Security model

This document describes what `guarded-computer-use-mcp` defends against, what it
does not, and the two bypasses that were found and fixed on 2026-09-15. Read it
before you point an agent at this server.

Short version: **it is not a sandbox.** An agent driving this server runs with
your user's privileges, on your real desktop, with no VM and no undo. The guards
reduce the blast radius and make what happened reviewable. They do not make the
agent safe, and there is no configuration that does.

---

## 1. Threat model

| Actor | Defended? | By what |
|---|---|---|
| The model, acting on its own initiative or on instructions injected into a page/PDF/chat it read | **Partly** | deny lists (hard refusal), approval dialog for dangerous patterns and always-ask targets, rate limit, `pending_safety_check` |
| The model issuing *parallel* tool calls to answer its own approval dialog | **Yes** (fixed 2026-09-15) | server-side gate lock + physical-input filter in the dialog |
| Another local process / MCP server injecting input to answer the dialog | **Partly** | the dialog ignores any event carrying the Windows `LLKHF_INJECTED` / `LLMHF_INJECTED` flag, so `SendInput` from anywhere is discarded. A UIAutomation `InvokePattern` is *not* covered — see §4.1 |
| A same-user process that can write files in this directory | **No** | markers are signed, so a forged marker is ignored and reported, but `guard.key` is readable by that same user. This is a speed bump plus a tripwire, not a boundary |
| An administrator, or anything running as SYSTEM | **No** | it can do whatever it likes to the files, the process, and the desktop |
| Your own misclicks | **No** | the dialog asks; it does not know what you meant |

The design assumption is that the agent is **untrusted but not omniscient**: it
can run tools, read your screen, and possibly write files through *another*
server, but it cannot press a physical key.

---

## 2. The layers, and what each actually buys

1. **Deny lists** (`policy.json`) — hard refusal before anything happens; no
   `confirm: true` override at any time. Matched as case-insensitive substrings
   against the process name and window title of the window the action would
   actually land on (`WindowFromPoint` for coordinate actions, the real cursor
   position for actions with no coordinates, and both ends of a `drag`).
   Substring matching is deliberately simple and is a **speed bump**: it will miss
   things, and it will produce false positives.
2. **Approval dialog** — blocks the tool call until a human answers. Exit code
   decides: `0` allow, `1` deny, `2` timeout (auto-deny), `3` unavailable,
   `4` allow + remember for this session. Enter is deliberately unbound. The
   allow decision is taken from the input hooks, not from the button: a
   `PostMessage(BM_CLICK)`, a posted `WM_KEYDOWN`, or a UIAutomation
   `InvokePattern` fires the Click handler but sets no physical flag, so it is
   refused and reported on the dialog.
3. **Gate lock** — while a dialog is open, every tool that injects input or
   changes the foreground is refused (`refused_by_approval_gate`), and the check
   is repeated after every `await` (including once per `batch` step, both before
   and after the step's target lookup). This exists because MCP tool handlers are
   async: without it, a second tool call issued in parallel could answer the
   dialog. Only one dialog is shown at a time; a second approval-requiring call
   is refused instead of stacking.
4. **Physical-input filter** — the dialog installs low-level keyboard and mouse
   hooks and swallows every injected event, and requires a *physical* Alt+A or a
   physical click inside the Allow button to allow. The count of ignored
   injections is shown on the dialog and printed when it closes.
5. **Signed, non-replayable switches** — `.approval-off`, `.guard-off`,
   `.audit-off`, `.physical-off` are only honoured if they carry a valid HMAC
   over the switch name, state, timestamp and a per-switch counter. An unsigned
   or edited marker is ignored (fail closed), and a marker whose counter is not
   newer than the accepted one — a replayed marker — is refused as well. Both are
   recorded as `guard_tamper` in the audit log and in the tool result the model
   sees.
6. **Audit log** — every action with its resolved target process, redacted for
   sensitive argument values, chained with `prev`/`hash`, plus a chain head
   (`audit.head.json`) recording how far the segment got. `npm run audit:verify`
   therefore detects an edited record, a broken link, a deleted tail, a deleted
   file and a stripped hash — and reports pre-chaining records as `legacy` so an
   existing log can be upgraded.
7. **Rate limit** — `max_actions_per_minute`, to stop a runaway loop.
8. **Launch check** — `launch_app` refuses shells and LOLBins by executable name
   (`deny_launch_targets`, plus the process deny list). The launched program is
   not a window, so no window list can judge it.

---

## 3. What an adversarial review found, and what was done about it

The first round of fixes below was itself reviewed adversarially on 2026-09-15.
That review broke several of them; both rounds are recorded here because the
second round is the more instructive one.

### 3.1 Parallel tool call answers its own approval dialog

`requestApproval()` awaits a child process while the dialog is on screen. Tool
handlers in `server.js` are `async`, so the MCP client could dispatch another
call in the meantime — and a model doing parallel tool calls does exactly that.
`key("alt+a")`, `click(x, y)` on the Allow button, or
`click_element(name: "Allow")` answered the prompt on the user's behalf.

The README's claim that "only a real human action can proceed — the model cannot
forge one" was **false as written**.

Fixed by (3) and (4) above, independently: the gate lock refuses the call, and
the dialog requires a physical event.

Regression tests: `npm run test:inject` shows the real dialog, injects Alt+A and
a click on Allow through this server's own `host.ps1`, posts `BM_CLICK` and
`WM_SYSKEYDOWN` at the real button, and asserts the dialog still times out with
exit code 2. `npm run test:lock` drives the real server over stdio JSON-RPC,
leaves a `type_text` call blocked on the dialog, and asserts that `key("alt+a")`
and `click` issued in parallel come back `refused_by_approval_gate` in a few
milliseconds — the protocol-level proof that a second call cannot answer the
first call's prompt.

### 3.2 `batch` bypassed the deny lists

The `batch` handler called the step functions directly and only consulted
`needsApproval()`. `policyGuard()` — the deny lists, the allow list and the rate
limit — was never applied to steps. One call could therefore type into a
password manager or click inside `regedit`:

```json
{"steps": [{"op": "type_text", "args": {"text": "master password"}}]}
```

Fixed: every step now runs `policyGuard()`, the launch check and the gate lock,
and is denied and audited individually.

### 3.3 Holes the review found in the fixes above

- **`batch` still did not re-check the gate after its own awaits.** Resolving a
  step's target can take hundreds of milliseconds (UIA lookup); a parallel call
  could open a dialog inside that window, and the step then ran anyway. The lock
  is now re-checked after every await and immediately before the handler.
- **`confirm: true` was a model-controlled master key.** It silenced the
  destructive-pattern checks and the fail-closed check, so
  `key("alt+f4", confirm: true)` needed no human. `confirm` is now honoured only
  while the approval gate is switched off (the operator's own decision); with the
  gate on, the dialog is the only way through.
- **Two dialogs could be open at once**, and the lock lifted when the first one
  closed. Only one dialog is shown now; a second approval-requiring call is
  refused.
- **Ignoring injected input was not enough.** Any same-user process could
  `PostMessage(BM_CLICK)` at the Allow button (or `WM_SYSKEYDOWN` Alt+A at the
  form) and the WinForms Click handler would fire with no input event to inspect.
  The allow decision is now taken from the hooks themselves, which also covers a
  UIAutomation `InvokePattern` (it fires the same handler).
- **A deleted or stripped audit log verified OK.** Truncating the tail, deleting
  the file, or removing the `hash` fields all passed, because a truncated chain is
  still a valid chain. `record()` now writes a chain head, `verify` compares
  against it, and a hash removed *after* a chained record is tampering.
- **Guard markers could be replayed.** They carried no expiry and no counter, so
  restoring an old, validly signed marker turned a layer back off. Markers now
  carry a per-switch counter and the highest accepted value is remembered.
- **`launch_app` was never checked against what it launches**, `click`/`scroll`
  with no coordinates were checked against the foreground window rather than the
  cursor, `click` with `x` but no `y` landed at `(x, 0)`, and a `drag` was checked
  only where it started. All four are fixed.
- **The guard secret leaked to children.** `COMPUTER_USE_GUARD_SECRET` was
  inherited by the host shell — and therefore by anything `launch_app` started,
  making `cmd /c set > file` enough to read it. Child processes no longer get it.
- **Refusals were logged as successes**, and "remember for this session" was keyed
  only by window, so approving one control pre-approved the next one. Both fixed.

---

## 4. What is still not covered

### 4.1 Whoever can write files as you can still win

The dialog's physical-input requirement closes the automated routes to *Allow*
(`SendInput`, posted messages, UIA `InvokePattern`). It does not change the fact
that everything here is a same-user control:

- `guard.key` is readable, so a marker can be signed; if it is not readable it can
  be **replaced** with one the attacker chooses (the server reads it once at
  start, so this takes effect on the next run).
- `guard.state.json` (accepted-marker watermark) and `audit.head.json` (chain
  head) can be rolled back together with the files they describe.
- `policy.json` can be edited to widen every list, and `host.ps1` can be run
  directly, bypassing `server.js` and every layer above.

Practical consequence: keep the install directory somewhere the agent's file and
terminal tools cannot write, put `COMPUTER_USE_GUARD_SECRET` in the launcher's
environment rather than in `guard.key`, and treat `guard_tamper` events as an
incident. Those raise the cost; they are not a boundary against your own user
account.


### 4.2 Marker forgery, replay and key substitution, in detail

`guard.key` is readable by anything running as you, so a sufficiently motivated
agent can sign its own `.guard-off`. Mitigations, in increasing strength:

* keep `guard.key` out of reach and set `COMPUTER_USE_GUARD_SECRET` in the
  environment of whoever launches the server — an agent that cannot read that
  environment cannot forge a marker;
* keep the switches on and treat `guard_tamper` events (in the tool result and
  in `audit.jsonl`) as an incident.

If the key cannot be *read*, it can still be **replaced** with one of the
attacker's choosing and used to sign markers; the server reads it once and caches
it, so that takes effect on the next start. The signature defends against a
marker being invented or edited, not against the key being substituted from under
it. `secretStatus().fingerprint` (recorded in the audit log at every start) makes
a substitution visible between runs.

Replay is a separate axis and is now covered by the per-switch counter: an old,
validly signed marker restored after the switch was cleared is refused. Rolling
back `guard.state.json` together with the marker defeats it — same trust
boundary, which is why §4.1 is the honest summary.

Making a marker **unreadable** fails closed (the protection stays on) and shows
up as `guard_tamper`, so it costs an attacker nothing except a warning.

### 4.3 `policy.json` and `host.ps1` have no gate of their own

The gate lives in `server.js`. Anything that can edit `policy.json` can widen
the lists, and anything that can run `host.ps1` directly bypasses every layer
in this document — including the approval dialog, which is a separate process
started by `server.js`. Same-user file access defeats the whole model; that is
why the mitigations above are about *withholding* access rather than detecting
it.

### 4.4 Your screen leaves your machine

Screenshots, OCR output, clipboard contents and window titles are sent to your
model provider — that is the point of a computer-use server, but it means
everything visible while the agent runs is transmitted off-device, including
other people's messages and documents. Prefer `zoom` on a region over a full
screenshot, and check your provider's retention policy.

### 4.5 Prompt injection

Everything the agent reads is untrusted input: a web page, a PDF, an email, a
chat message, a code comment. A hostile page can instruct the agent to do
something you never asked for. The guards catch actions matching the patterns
and lists; a plausible-looking click in an app on neither list is not caught.

### 4.6 Windows boundaries

UIPI blocks input injection into elevated windows, and the UAC secure desktop is
unreachable. That is a Windows property, not a feature of this server.

---

## 5. Recommended configuration

* Keep all four switches **on** (the default) and watch for `guard_tamper`
  warnings.
* Put the server's install directory somewhere the agent's file/terminal tools
  cannot write, and set `COMPUTER_USE_GUARD_SECRET` in the launcher's
  environment.
* Fill `allow_processes` with just the apps you actually want automated; an
  allow list is far stronger than the deny lists.
* If you need real isolation, run the agent inside a VM and point it at that
  VM's desktop. "Control the real machine" and "full isolation" are
  architecturally mutually exclusive.
* Review `audit.jsonl` (`npm run audit:verify`, `npm run guard`) after any
  session you did not watch closely.

---

## 6. Reporting

Open a GitHub issue at
<https://github.com/be1st6666/guarded-computer-use-mcp/issues> for
non-sensitive reports. For anything that would let an agent escape the guards in
a way this document does not already describe, please describe the mechanism and
a minimal reproduction; the two fixes above came from exactly that kind of
report.

Provided under the MIT licence, without warranty of any kind.
