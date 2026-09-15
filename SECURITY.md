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

1. **Deny lists** (`policy.json`) — hard refusal before anything happens, no
   `confirm: true` override. Matched as case-insensitive substrings against the
   process name and window title of the window the action would actually land
   on (`WindowFromPoint`, not the foreground window). Substring matching is
   deliberately simple and is a **speed bump**: it will miss things, and it will
   produce false positives.
2. **Approval dialog** — blocks the tool call until a human answers. Exit code
   decides: `0` allow, `1` deny, `2` timeout (auto-deny), `3` unavailable,
   `4` allow + remember for this session. Enter is deliberately unbound.
3. **Gate lock** — while a dialog is open, every tool that injects input or
   changes the foreground is refused (`refused_by_approval_gate`). This exists
   because MCP tool handlers are async: without it, a second tool call issued in
   parallel could answer the dialog.
4. **Physical-input filter** — the dialog installs low-level keyboard and mouse
   hooks and swallows every injected event, so `SendInput` cannot press Alt+A or
   click Allow. The count of ignored injections is shown on the dialog and
   printed when it closes.
5. **Signed switches** — `.approval-off`, `.guard-off`, `.audit-off`,
   `.physical-off` are only honoured if they carry a valid HMAC over the switch
   name and timestamp. An unsigned or edited marker is ignored (fail closed) and
   recorded as `guard_tamper` in the audit log and in the tool result the model
   sees.
6. **Audit log** — every action with its resolved target process, redacted for
   sensitive argument values, chained with `prev`/`hash` so edits and deletions
   are detectable: `npm run audit:verify`.
7. **Rate limit** — `max_actions_per_minute`, to stop a runaway loop.

---

## 3. Two bypasses found and fixed on 2026-09-15

Both were reachable by a model that simply tried; neither required local code
execution.

### 3.1 Parallel tool call answers its own approval dialog

`requestApproval()` awaits a child process while the dialog is on screen. Tool
handlers in `server.js` are `async`, so the MCP client could dispatch another
call in the meantime — and a model doing parallel tool calls does exactly that.
`key("alt+a")`, `click(x, y)` on the Allow button, or
`click_element(name: "Allow")` answered the prompt on the user's behalf.

The README's claim that "only a real human action can proceed — the model cannot
forge one" was **false as written**.

Fixed by (3) and (4) above, independently: the gate lock refuses the call, and
the dialog would ignore the injected input even if it were somehow sent.

Regression tests: `npm run test:inject` shows the real dialog, injects Alt+A and
a click on Allow through this server's own `host.ps1`, and asserts the dialog
still times out with exit code 2. `npm run test:lock` drives the real server over
stdio JSON-RPC, leaves a `type_text` call blocked on the dialog, and asserts that
`key("alt+a")` and `click` issued in parallel come back `refused_by_approval_gate`
in a few milliseconds — the protocol-level proof that a second call cannot answer
the first call's prompt.

### 3.2 `batch` bypassed the deny lists

The `batch` handler called the step functions directly and only consulted
`needsApproval()`. `policyGuard()` — the deny lists, the allow list and the rate
limit — was never applied to steps. One call could therefore type into a
password manager or click inside `regedit`:

```json
{"steps": [{"op": "type_text", "args": {"text": "master password"}}]}
```

Fixed: every step now runs `policyGuard()` (and the gate lock) and is denied and
audited individually.

---

## 4. What is still not covered

### 4.1 UIAutomation can press Allow

The low-level hooks see injected *input*. `IUIAutomationInvokePattern` is not
input — it is a cross-process call that activates a control directly. A second
MCP server (or any local process with UIA access and the same user rights) can
invoke the dialog's Allow button without ever touching the hook. The gate lock
covers this server's own `click_element`, not somebody else's.

Practical consequence: **run one desktop-control server at a time.** If you run
two, the approval dialog is not a meaningful boundary between them.

### 4.2 A same-user attacker can forge markers

`guard.key` is readable by anything running as you, so a sufficiently motivated
agent can sign its own `.guard-off`. Two mitigations, in increasing strength:

* keep `guard.key` out of reach and set `COMPUTER_USE_GUARD_SECRET` in the
  environment of whoever launches the server — an agent that cannot read that
  environment cannot forge a marker;
* keep the switches on and treat `guard_tamper` events (in the tool result and
  in `audit.jsonl`) as an incident.

### 4.3 `policy.json` and `host.ps1` have no gate of their own

The gate lives in `server.js`. Anything that can edit `policy.json` can widen
the lists, and anything that can run `host.ps1` directly bypasses every layer
in this document. Same-user file access defeats the whole model; that is why
the mitigations above are about *withholding* access rather than detecting it.

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
