# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0/).

## [0.2.0] — unreleased

Hardening release: two real bypasses fixed, the guard switches are signed, and
the audit log is redacted and hash-chained.

### Security

- **Fixed: a parallel tool call could answer its own approval dialog.** Tool
  handlers are async, so while the dialog blocked one call, a second call issued
  in parallel could run `key("alt+a")`, `click(x, y)` on Allow, or
  `click_element(name: "Allow")` and approve the action on the user's behalf.
  Both defences are independent now: an input-tool lock refuses any
  input-injecting tool while a dialog is open (`refused_by_approval_gate`), and
  the dialog installs low-level keyboard/mouse hooks that discard every event
  carrying the Windows `injected` flag, so `SendInput` from any tool cannot
  answer it. The dialog shows how many injections it ignored. Regression test:
  `npm run test:inject`. The README claim that "the model cannot forge one" was
  false as written and has been replaced with what is actually true.
- **Fixed: `batch` bypassed the deny lists.** Steps called the handlers directly
  and only consulted the approval check, so a single `batch` call could type
  into a password manager or click inside `regedit`. Every step now runs the
  policy guard, the gate lock and the audit log.
- **Guard switches are HMAC-signed.** `.approval-off` / `.guard-off` /
  `.audit-off` / `.physical-off` used to be honoured on existence alone, so
  anything that could write a file in the install directory — including the
  agent, when it also has a file or terminal tool — could disable the guard.
  An unsigned or hand-edited marker is now ignored (fail closed) and recorded as
  `guard_tamper` in the audit log and in the next tool result. Key: `guard.key`,
  or `COMPUTER_USE_GUARD_SECRET` in the launcher's environment.
  `COMPUTER_USE_GUARD_ALLOW_PLAIN=1` restores the old behaviour for anyone who
  wants it (tampering is still logged).
- **Audit log**: sensitive argument values are redacted (key-based, recursing
  into `batch` steps), window titles are capped at 80 characters and can be
  fingerprinted with `audit: { redact_titles: true }`, records carry a `prev` /
  `hash` chain so edits and deletions are detectable (`npm run audit:verify`),
  and the file rotates at a size cap. Records written by earlier versions are
  reported as `legacy`, not as tampering.
- `policy.json`'s `approval` block is merged key by key: `"approval": {"enabled":
  false}` no longer drops `timeout_ms` and `require_physical_input`.
- The audit log now records `session_start` / `session_end` (shell, policy path,
  guard states, key source) and every guard tamper.

### Added

- `SECURITY.md` — threat model, what each layer really buys, the two fixed
  bypasses, and the residual gaps (UIAutomation can still press Allow from a
  *second* desktop-control server; `guard.key` is readable by your user; the
  deny lists are substring matches; the chain is tamper-evident, not
  tamper-proof).
- Fourth switch `物理输入校验` (`.physical-off`) in the panel.
- `src/` modules, so the safety core is unit-testable: `guard.js` (signed
  switches), `audit.js` (redaction, chain, rotation), `policy.js` (lists, rate
  limit, approval decision), `approval.js` (dialog + gate lock), plus `host.js`,
  `ocr.js`, `shell.js`, `paths.js`.
- Tests: 55 unit tests (`npm run test:unit`), an MCP handshake/schema smoke test
  (`npm run test:smoke`, headless-safe) and the injected-input end-to-end test
  (`npm run test:inject`). `npm run verify` runs everything that does not need an
  interactive desktop.
- ESLint + Prettier configuration, and a GitHub Actions workflow
  (windows-latest × Node 18/20/22).
- `npm run audit:verify`, `npm run guard`, `npm run verify`.

### Changed

- README and the Chinese README now state precisely what the guards do and do
  not stop, instead of promising that the model cannot get past them.
- `docs/make-*.ps1` are saved with a UTF-8 BOM like the other CJK scripts, so
  Windows PowerShell 5.1 reads their comments correctly.
- README figures regenerated from the live UI (dialog and four-switch panel).

### Removed

- Dead code in `server.js` (`toHostOp`, `pickShotOpts`) that no caller used.
- The unqualified "hard refusal, no override" / "needs a physical click" claims
  in the layer table.

## [0.1.0] — unreleased

First public release.

### Added

**Tools (26)**

- Observation: `screenshot`, `zoom`, `screen_hash`, `wait_for_change`,
  `cursor_position`, `list_displays`, `list_windows`, `active_window`,
  `clipboard_read`
- Semantic targeting via UI Automation: `find_elements`, `click_element`,
  `ui_tree`
- OCR: `ocr` — RapidOCR (PaddleOCR models on ONNXRuntime) by default, with the
  built-in Windows engine as an alternative
- Mouse: `mouse_move`, `click`, `drag`, `scroll`
- Keyboard: `type_text` (Unicode per character via `SendInput`), `key`,
  `hold_key`
- Windows: `activate_window`, `launch_app`
- Orchestration: `batch`, `wait`
- Other: `clipboard_write`, `bench`

**Safety**

- Policy engine with four independent lists — hard-refusal deny lists for
  processes and window titles, and approval-required lists for the same, so
  messaging/mail/remote-desktop apps are never clicked without a human.
- Human-in-the-loop approval dialog. `Enter` is deliberately unbound so a stray
  keystroke cannot approve anything; `Esc` denies; `Alt+A` allows; the countdown
  auto-denies. Optional "remember this target for this session".
- Guard panel (`guard-panel.cmd`) with three independent kill switches that take
  effect on the next call without restarting the server.
- Audit log (`audit.jsonl`) recording every action with its resolved target
  process.

**Performance**

- Resident PowerShell host with a C# helper compiled once at startup, so most
  calls cost 1–12 ms.
- `StretchBlt` capture and downscale in one GDI call.
- JPEG by default (4–8 ms encode vs 19–33 ms for PNG).
- `screen_hash` returns a 64×40 fingerprint in 9 tokens, versus ~2133 for a
  full screenshot.
- RapidOCR runs as a warm worker that idle-exits, so repeat OCR costs ~350 ms
  instead of ~2.3 s while holding ~96 MB only while in use.
- OCR latency scales with the number of recognised text boxes, not the capture
  rectangle: a text-heavy full 2560x1600 screen measured ~6.9 s / 105 boxes,
  versus ~3.3 s / 45 boxes for a 1280x800 region. Pre-downscaling does not help
  (the detector normalises its input internally) and a larger recognition batch
  is slower, so pass a region instead of OCRing the whole screen.

### Known limitations

- Windows only.
- ~55 ms per full screenshot is the GDI readback floor.
- No continuous vision; the loop is act → observe → decide.
- Not a sandbox: the agent runs with your privileges on your real desktop.
- UIPI blocks input into elevated windows; the UAC secure desktop is unreachable.
