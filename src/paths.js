/**
 * Single place that answers "where is this project on disk?".
 *
 * Everything else (the PowerShell host, the OCR helper, policy.json, the audit
 * log, the guard markers) is addressed relative to ROOT, so the server keeps
 * working no matter how it was cloned or where it is launched from.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Project root (the directory that holds server.js). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
