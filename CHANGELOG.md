# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0/).

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
