/**
 * Shared helpers for the unit tests in test/*.test.mjs.
 *
 * The repo is live on this machine, so every test points its module at a fresh
 * temp directory (guard markers + guard.key, audit.jsonl, policy.json) and
 * removes it afterwards. Nothing here ever touches the real repo files.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Fresh unique temp dir, e.g. .../guard-Ab12Cd */
export function tempDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

/** Best-effort cleanup; never fails a test on a locked file. */
export function removeDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** Write a JSON policy to `dir/policy.json` and return the path. */
export function writePolicy(dir, object) {
  const file = path.join(dir, 'policy.json');
  writeFileSync(file, JSON.stringify(object, null, 2));
  return file;
}

/** Write arbitrary text (e.g. malformed JSON) and return the path. */
export function writeText(dir, name, text) {
  const file = path.join(dir, name);
  writeFileSync(file, text);
  return file;
}

/** Parse an MCP-style result back into the JSON object its text carries. */
export function jsonOf(result) {
  return JSON.parse(result.content[0].text);
}
