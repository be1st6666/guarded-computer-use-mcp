/**
 * Shell / interpreter discovery.
 *
 * Nothing here is tied to one machine: every candidate is probed with existsSync
 * and the first one that actually spawns wins. Set COMPUTER_USE_SHELL or
 * COMPUTER_USE_UV to force a specific interpreter.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Existing file, or undefined — keeps the candidate list honest. */
export const existing = (p) => (p && existsSync(p) ? p : undefined);

/**
 * Shell preference order. PowerShell 7 is strongly preferred: it reads UTF-8
 * scripts without a BOM, parses large JSON, and has modern operators. Windows
 * PowerShell 5.1 stays as a fallback so the server works on a machine without
 * pwsh.
 */
export const SHELL_CANDIDATES = [
  process.env.COMPUTER_USE_SHELL,
  'pwsh.exe', // PATH
  existing(path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')),
  existing(path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'pwsh.exe')),
  'powershell.exe', // always present on Windows
  existing(
    path.join(
      process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    ),
  ),
  existing(
    path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ),
].filter(Boolean);

/** Same idea for the OCR helper's runner. */
export const UV_CANDIDATES = [
  process.env.COMPUTER_USE_UV,
  'uv',
  existing(path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python', 'Python310', 'Scripts', 'uv.exe')),
  existing(path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'uv.exe')),
].filter(Boolean);

/** `-File <script>` under the same policy for every PowerShell we spawn. */
export function psFileArgs(script, args = []) {
  return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args];
}

/**
 * Environment for every child process we start.
 *
 * COMPUTER_USE_GUARD_SECRET is the one secret that must not leak: the host
 * shell, the OCR worker and the approval dialog are all spawned by this server,
 * and `launch_app` executes arbitrary programs *from the host shell*, so
 * anything in this environment is reachable by a program the agent chooses to
 * launch (`cmd /c set > file` was enough to read it). Children get everything
 * else.
 *
 * Not a boundary against a same-user process — it can still read the server's
 * own environment through the PEB — but it removes the trivial "ask the server
 * to print its own env" path. See SECURITY.md §4.2.
 */
export function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.COMPUTER_USE_GUARD_SECRET;
  delete env.COMPUTER_USE_GUARD_ALLOW_PLAIN;
  return env;
}
