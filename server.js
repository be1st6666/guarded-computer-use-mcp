#!/usr/bin/env node
/**
 * computer-use-mcp —— 自建的 Windows 桌面控制 MCP 服务
 *
 * 设计原则：
 *   1. 不引入任何第三方自动化代码。全部能力由本仓库的 host.ps1（C# + Win32）实现。
 *   2. 唯一依赖是官方 @modelcontextprotocol/sdk。
 *   3. 常驻一个 PowerShell 宿主进程，C# 帮助类只编译一次 —— 单次调用约 20-60ms，而不是 300ms+。
 *   4. 文本输入走 SendInput Unicode，中文/引号/emoji 原样送出，不做任何字符串转义。
 *   5. 启动时先设 DPI 感知 —— 截图坐标与鼠标坐标严格同一物理坐标系。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST_SCRIPT = path.join(HERE, 'host.ps1');

/** Existing file, or undefined — keeps the candidate list honest. */
const existing = (p) => (p && existsSync(p) ? p : undefined);

/**
 * Shell preference order. PowerShell 7 is strongly preferred: it reads UTF-8
 * scripts without a BOM, parses large JSON, and has modern operators. Windows
 * PowerShell 5.1 stays as a fallback so the server works on a machine without
 * pwsh.
 *
 * Every entry is resolved at runtime — nothing is tied to one machine. Set
 * COMPUTER_USE_SHELL to force a specific interpreter.
 */
function shellCandidates() {
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const lad = process.env.LOCALAPPDATA ?? '';
  return [
    process.env.COMPUTER_USE_SHELL,
    'pwsh.exe',                                        // PATH
    existing(path.join(pf, 'PowerShell', '7', 'pwsh.exe')),
    existing(path.join(lad, 'Microsoft', 'WindowsApps', 'pwsh.exe')),
    'powershell.exe',                                  // always present on Windows
    existing(path.join(pf86, 'WindowsPowerShell', 'v1.0', 'powershell.exe')),
    existing(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')),
  ].filter(Boolean);
}
const SHELL_CANDIDATES = shellCandidates();

/** Same idea for the OCR helper's runner. */
function uvCandidates() {
  const lad = process.env.LOCALAPPDATA ?? '';
  return [
    process.env.COMPUTER_USE_UV,
    'uv',
    existing(path.join(lad, 'Programs', 'Python', 'Python310', 'Scripts', 'uv.exe')),
    existing(path.join(lad, 'Microsoft', 'WindowsApps', 'uv.exe')),
  ].filter(Boolean);
}
const UV_CANDIDATES = uvCandidates();

function spawnCandidate(cmd) {
  return new Promise((resolve, reject) => {
    const ps = spawn(
      cmd,
      ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HOST_SCRIPT],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );
    let settled = false;
    ps.once('error', (e) => { if (!settled) { settled = true; reject(e); } });
    ps.once('spawn', () => { if (!settled) { settled = true; resolve(ps); } });
  });
}

/* ------------------------------------------------------------------ 宿主进程 */
class PsHost {
  constructor() {
    this.proc = null;
    this.spawnPromise = null;
    this.buf = '';
    this.pending = new Map();
    this.nextId = 1;
    this.shell = null;
  }

  async ensure() {
    if (this.proc && !this.proc.killed) return;
    if (this.spawnPromise) return this.spawnPromise;

    this.spawnPromise = (async () => {
      let lastErr;
      for (const cmd of SHELL_CANDIDATES) {
        try {
          const ps = await spawnCandidate(cmd);
          this.proc = ps;
          this.shell = cmd;
          process.stderr.write(`[computer-use] host shell: ${cmd}\n`);
          ps.stdout.setEncoding('utf8');
          ps.stderr.setEncoding('utf8');
          ps.stdout.on('data', (d) => this.#onData(d));
          ps.stderr.on('data', (d) => process.stderr.write('[host] ' + d));
          ps.on('exit', (code) => {
            for (const p of this.pending.values()) p.reject(new Error(`shell host exited (code ${code})`));
            this.pending.clear();
            this.proc = null;
            this.spawnPromise = null;
          });
          return;
        } catch (e) {
          lastErr = e;
        }
      }
      this.spawnPromise = null;
      throw new Error(`no usable shell found (tried ${SHELL_CANDIDATES.join(', ')}): ${lastErr?.message}`);
    })();

    await this.spawnPromise;
    // 首次 ping 会把 C# 编译成本付掉
    await this.raw('ping', {}, 90000);
  }

  #onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(Buffer.from(line, 'base64').toString('utf8'));
      } catch {
        continue;
      }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error));
    }
  }

  raw(op, args = {}, timeoutMs = 30000) {
    const id = this.nextId++;
    const payload = Buffer.from(JSON.stringify({ id, op, args }), 'utf8').toString('base64');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`host timeout after ${timeoutMs}ms (op=${op})`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.proc.stdin.write(payload + '\n');
    });
  }

  async call(op, args = {}, timeoutMs = 30000) {
    await this.ensure();
    return this.raw(op, args, timeoutMs);
  }

  dispose() {
    try { this.raw('shutdown', {}, 2000).catch(() => {}); } catch { /* ignore */ }
  }
}

const host = new PsHost();

/* ------------------------------------------------------------------ MCP */
// 版本从 package.json 读，避免两处不一致
const PKG = JSON.parse(readFileSync(path.join(HERE, 'package.json'), 'utf8'));
const server = new McpServer(
  { name: PKG.name, version: PKG.version },
  { capabilities: { tools: {} } }
);

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const json = (v) => text(JSON.stringify(v, null, 2));

/** 统一包装：先过安全闸门，再把任何异常变成 MCP 的 isError 结果 */
const HANDLERS = new Map();

function tool(name, config, fn) {
  HANDLERS.set(name, fn);
  server.registerTool(name, config, async (args, extra) => {
    try {
      const target = await resolveTarget(name, args);
      const blocked = policyGuard(name, args, target);
      if (blocked) { await audit(name, args, blocked, target); return blocked; }

      const check = needsApproval(name, args, target);
      if (check) {
        if (sessionApprovals.has(approvalKey(name, target))) {
          // 用户在本会话里勾选了"记住这个目标"，直接放行
        } else if (approvalEnabled()) {
          const code = await requestApproval(name, args, check, target);
          if (code !== 0) {
            const res = approvalDenied(name, args, check, code);
            await audit(name, args, res, target);
            return res;
          }
          // 用户点了允许 —— 继续执行
        } else {
          const pending = pendingCheck(name, args, check);
          await audit(name, args, pending, target);
          return pending;
        }
      }

      const res = await fn(args, extra);
      await audit(name, args, res, target);
      return res;
    } catch (e) {
      const err = { isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] };
      await audit(name, args, err);
      return err;
    }
  });
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/* ---- 观察 ---------------------------------------------------------- */

/** 把 MCP 工具名+参数翻译成宿主 op+参数（batch 用） */
function toHostOp(name, args = {}) {
  switch (name) {
    case 'zoom':
      return ['screenshot', { x: args.x, y: args.y, width: args.width, height: args.height, ...pickShotOpts(args) }];
    case 'screenshot':
      return ['screenshot', { ...args }];
    case 'screen_hash':
      return ['fingerprint', { ...args }];
    case 'batch':
      throw new Error('batch cannot be nested inside batch');
    default:
      return [name, args];
  }
}

function pickShotOpts(a) {
  const o = {};
  for (const k of ['max_side', 'format', 'quality', 'interp']) if (a[k] !== undefined) o[k] = a[k];
  return o;
}

function shotContent(r) {
  const note = r.capturedWidth !== r.width ? ` (downscaled from ${r.capturedWidth}x${r.capturedHeight})` : '';
  const ms = r.ms ? ` capture ${r.ms.capture}ms scale ${r.ms.scale}ms encode ${r.ms.encode}ms b64 ${r.ms.base64}ms` : '';
  const kb = r.bytes ? ` ${Math.round(r.bytes / 1024)}KB` : '';
  return [
    { type: 'image', data: r.data, mimeType: r.mime },
    { type: 'text', text: `${r.width}x${r.height}${note}${kb}${ms}` },
  ];
}

const SHOT_OPTS = {
  max_side: z.number().int().min(0).max(4000).optional()
    .describe('Longest-side cap for the returned image (default 1600; 0 = native)'),
  format: z.enum(['jpeg', 'png']).optional().describe('Encoding (default jpeg: ~4x faster to encode)'),
  quality: z.number().int().min(1).max(100).optional().describe('JPEG quality (default 88)'),
  interp: z.enum(['nearest', 'bilinear', 'bicubic']).optional()
    .describe('Downscale filter (default bilinear; bicubic is slower)'),
};

tool('screenshot', {
  title: 'Screenshot',
  description:
    'Capture the screen (or a rectangular region) as an image. Coordinates are physical pixels of the ' +
    'virtual desktop, the same space that click/mouse_move use. Omit all region args for the full screen. ' +
    'The image is downscaled when its longest side exceeds max_side; use zoom for native-resolution detail.',
  inputSchema: {
    x: z.number().int().optional().describe('Region left edge (virtual-desktop pixels)'),
    y: z.number().int().optional().describe('Region top edge'),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    ...SHOT_OPTS,
  },
  annotations: READ_ONLY,
}, async ({ x, y, width, height, ...opts }) => {
  const region = x !== undefined && y !== undefined && width && height;
  const r = await host.call('screenshot', {
    ...(region ? { x, y, width, height } : {}),
    ...opts,
  });
  return { content: shotContent(r) };
});

tool('zoom', {
  title: 'Zoom into a region',
  description:
    'Capture a small region at native resolution — use this to read fine detail such as UI labels or icons.',
  inputSchema: {
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    ...SHOT_OPTS,
  },
  annotations: READ_ONLY,
}, async ({ x, y, width, height, ...opts }) => {
  const r = await host.call('screenshot', { x, y, width, height, ...opts });
  return { content: shotContent(r) };
});

tool('screen_hash', {
  title: 'Screen fingerprint',
  description:
    'Cheap perceptual fingerprint of the screen (or a region). Call it, act, call it again — a changed ' +
    'hash means the screen actually changed. Costs a few ms instead of a full screenshot.',
  inputSchema: {
    x: z.number().int().optional(),
    y: z.number().int().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  },
  annotations: READ_ONLY,
}, async ({ x, y, width, height }) => {
  const region = x !== undefined && y !== undefined && width && height;
  return json(await host.call('fingerprint', region ? { x, y, width, height } : {}));
});

tool('wait_for_change', {
  title: 'Wait for screen change',
  description:
    'Block until the screen (or a region) actually changes, then return. This is the event-driven ' +
    'alternative to sleep-then-screenshot: no polling from the model, no wasted turns. ' +
    'Returns changed=false when the timeout elapses first.',
  inputSchema: {
    timeout_ms: z.number().int().min(1).max(120000).optional().describe('Default 10000'),
    interval_ms: z.number().int().min(20).max(5000).optional().describe('Poll interval, default 120'),
    x: z.number().int().optional(),
    y: z.number().int().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  },
  annotations: READ_ONLY,
}, async ({ timeout_ms, interval_ms, x, y, width, height }) => {
  const region = x !== undefined && y !== undefined && width && height;
  return json(await host.call('wait_for_change', {
    timeout_ms: timeout_ms ?? 10000,
    interval_ms: interval_ms ?? 120,
    ...(region ? { x, y, width, height } : {}),
  }, (timeout_ms ?? 10000) + 15000));
});

tool('batch', {
  title: 'Batch actions in one call',
  description:
    'Run several actions in one round trip, e.g. [click, wait, screenshot] — the model makes ONE tool call ' +
    'and gets the post-action state back. Steps run in order; screenshots come back as images. ' +
    'Use step names from this server (screenshot, zoom, click, type_text, key, wait, activate_window, ...).',
  inputSchema: {
    steps: z.array(z.object({
      op: z.string().describe('Tool name, e.g. "click"'),
      args: z.record(z.string(), z.any()).optional(),
    })).min(1).max(40),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}, async ({ steps }) => {
  const content = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepArgs = step.args ?? {};
    const stepTarget = await resolveTarget(step.op, stepArgs);
    const check = needsApproval(step.op, stepArgs, stepTarget);
    if (check) {
      // 批处理里不弹窗（会打断整批），直接跳过该步并说明原因
      content.push({
        type: 'text',
        text: `#${i + 1} ${step.op}: BLOCKED — ${check.reason} ` +
              `(run it as a separate call so the approval dialog can appear)`,
      });
      continue;
    }
    const fn = HANDLERS.get(step.op);
    if (!fn) {
      content.push({ type: 'text', text: `#${i + 1} ${step.op}: unknown tool` });
      continue;
    }
    const res = await fn(step.args ?? {}, {});
    if (res?.content) {
      // 图像块直接透传，文本块加序号前缀
      for (const c of res.content) {
        if (c.type === 'image') content.push(c);
        else content.push({ type: 'text', text: `#${i + 1} ${step.op}: ${c.text}` });
      }
    }
  }
  return { content };
});

tool('bench', {
  title: 'Benchmark capture pipeline',
  description: 'Time each stage of the screenshot pipeline across encoding/scale variants. Diagnostic only.',
  inputSchema: {},
  annotations: READ_ONLY,
}, async () => json(await host.call('bench', {}, 120000)));

tool('cursor_position', {
  title: 'Cursor position',
  description: 'Current mouse cursor position in physical pixels.',
  inputSchema: {},
  annotations: READ_ONLY,
}, async () => json(await host.call('cursor_position')));

tool('list_displays', {
  title: 'List displays',
  description: 'All monitors with their bounds in the virtual desktop coordinate space.',
  inputSchema: {},
  annotations: READ_ONLY,
}, async () => json(await host.call('list_displays')));

tool('list_windows', {
  title: 'List windows',
  description: 'All visible top-level windows with title, pid, minimized state and rect.',
  inputSchema: {},
  annotations: READ_ONLY,
}, async () => json(await host.call('list_windows')));

tool('active_window', {
  title: 'Active window',
  description: 'The foreground window (handle, pid, process name, title, rect).',
  inputSchema: {},
  annotations: READ_ONLY,
}, async () => json(await host.call('active_window')));

tool('clipboard_read', {
  title: 'Read clipboard',
  description: 'Read the clipboard as text.',
  inputSchema: {},
  annotations: READ_ONLY,
}, async () => json(await host.call('clipboard_read')));

/* ---- 鼠标 ---------------------------------------------------------- */

tool('mouse_move', {
  title: 'Move mouse',
  description: 'Move the cursor to (x, y) without clicking.',
  inputSchema: { x: z.number().int(), y: z.number().int() },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ x, y }) => { await host.call('mouse_move', { x, y }); return text(`moved to (${x}, ${y})`); });

tool('click', {
  title: 'Click',
  description: 'Click at (x, y), or at the current cursor position when x/y are omitted. count=2 for a double click.',
  inputSchema: {
    x: z.number().int().optional(),
    y: z.number().int().optional(),
    button: z.enum(['left', 'right', 'middle']).optional().describe('Default: left'),
    count: z.number().int().min(1).max(5).optional().describe('Default: 1'),
    confirm: z.boolean().optional().describe('Set true to proceed after a pending_safety_check'),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}, async ({ x, y, button, count }) => {
  await host.call('click', { x, y, button: button ?? 'left', count: count ?? 1 });
  return text(`clicked ${button ?? 'left'} x${count ?? 1} at ${x === undefined ? 'cursor' : `(${x}, ${y})`}`);
});

tool('drag', {
  title: 'Drag',
  description: 'Press at (x1, y1), move to (x2, y2), release. The move is interpolated in steps for reliability.',
  inputSchema: {
    x1: z.number().int(), y1: z.number().int(),
    x2: z.number().int(), y2: z.number().int(),
    button: z.enum(['left', 'right', 'middle']).optional(),
    steps: z.number().int().min(2).max(200).optional().describe('Default: 24'),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}, async ({ x1, y1, x2, y2, button, steps }) => {
  await host.call('drag', { x1, y1, x2, y2, button: button ?? 'left', steps: steps ?? 24 });
  return text(`dragged (${x1}, ${y1}) -> (${x2}, ${y2})`);
});

tool('scroll', {
  title: 'Scroll',
  description: 'Scroll the wheel at (x, y) (moves the cursor there first when given). amount is in wheel notches.',
  inputSchema: {
    x: z.number().int().optional(),
    y: z.number().int().optional(),
    direction: z.enum(['up', 'down']).optional().describe('Default: down'),
    amount: z.number().int().min(1).max(50).optional().describe('Default: 3'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ x, y, direction, amount }) => {
  const r = await host.call('scroll', { x, y, direction: direction ?? 'down', amount: amount ?? 3 });
  return text(`scrolled ${direction ?? 'down'} ${Math.abs(r.notches)} notch(es)`);
});

/* ---- 键盘 ---------------------------------------------------------- */

tool('type_text', {
  title: 'Type text',
  description:
    'Type a string as Unicode keystrokes. Handles CJK, quotes, and emoji natively — no escaping needed. ' +
    'The target window must have keyboard focus.',
  inputSchema: { text: z.string().describe('Text to type') },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}, async ({ text: s }) => {
  const r = await host.call('type_text', { text: s });
  return text(`typed ${r.chars} character(s)`);
});

tool('key', {
  title: 'Press key combination',
  description:
    'Press a key or chord, e.g. "enter", "esc", "f5", "ctrl+c", "ctrl+shift+s", "alt+f4", "win+d".',
  inputSchema: { combo: z.string().describe('Key or "+"-joined chord'),
    confirm: z.boolean().optional().describe('Set true to proceed after a pending_safety_check') },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}, async ({ combo }) => { await host.call('key', { combo }); return text(`pressed ${combo}`); });

tool('hold_key', {
  title: 'Hold a key',
  description: 'Hold a key down for a duration (ms), e.g. to charge or repeat.',
  inputSchema: { key: z.string(), ms: z.number().int().min(1).max(10000),
    confirm: z.boolean().optional().describe('Set true to proceed after a pending_safety_check') },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}, async ({ key, ms }) => { await host.call('hold_key', { key, ms }); return text(`held ${key} for ${ms}ms`); });

/* ---- 窗口 / 剪贴板 ------------------------------------------------- */

tool('activate_window', {
  title: 'Activate window',
  description:
    'Bring a window to the foreground. Match by case-insensitive title substring, or by pid. ' +
    'A minimized window is restored first.',
  inputSchema: {
    title: z.string().optional().describe('Case-insensitive substring of the window title'),
    pid: z.number().int().positive().optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ title, pid }) => {
  if (title === undefined && pid === undefined) throw new Error('provide title or pid');
  return json(await host.call('activate_window', { title, pid }));
});

/* ---- OCR：截图取字，第三条路 -------------------------------------------
 * 控件树拿不到（canvas/游戏/网页）且视觉模型对小字不可靠时用这个。
 *
 * 两个引擎：
 *   rapidocr (默认) —— PaddleOCR 的模型跑在 ONNXRuntime 上，约 14MB，中文强
 *   windows         —— 系统自带 Windows.Media.Ocr，零依赖但漏大号字形
 *
 * Windows 引擎只能从 Windows PowerShell 5.1 调用（.NET Core 无 WinRT 投影），
 * RapidOCR 走 uv 拉起的 Python 进程。两者都只在调用时付进程启动成本。
 * ------------------------------------------------------------------- */

const OCR_SCRIPT = path.join(HERE, 'ocr.ps1');
const RAPID_SCRIPT = path.join(HERE, 'ocr_rapid.py');

/** 收 stdout 最后一行 JSON */
function collectJson(ps, label) {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    ps.stdout.setEncoding('utf8');
    ps.stderr.setEncoding('utf8');
    ps.stdout.on('data', (d) => { out += d; });
    ps.stderr.on('data', (d) => { err += d; });
    ps.on('error', reject);
    ps.on('close', (code) => {
      const line = out.trim().split('\n').filter(Boolean).pop() || '';
      if (!line) return reject(new Error(`${label} produced no output (exit ${code}) ${err.slice(0, 300)}`));
      let parsed;
      try { parsed = JSON.parse(line); } catch { return reject(new Error(`${label} output not JSON: ${line.slice(0, 200)}`)); }
      if (parsed.error) return reject(new Error(parsed.error));
      resolve(parsed);
    });
  });
}

function runWindowsOcr(rectArgs) {
  return collectJson(
    spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', OCR_SCRIPT, ...rectArgs], { windowsHide: true }),
    'windows-ocr'
  );
}

/* ---- RapidOCR 常驻 worker -------------------------------------------
 * 每次新起 Python 进程要重付 ~500ms 的模型初始化。这里启动一次、保持常驻，
 * 用管道按行收发；空闲超过 OCR_IDLE_MS 就自动退出，把 ~157MB 内存还回去。
 * ------------------------------------------------------------------- */

const OCR_IDLE_MS = Number(process.env.COMPUTER_USE_OCR_IDLE_MS ?? 60000);

function spawnUv(uv) {
  return new Promise((resolve, reject) => {
    const ps = spawn(
      uv,
      ['run', '--no-project', '--with', 'rapidocr-onnxruntime', 'python', RAPID_SCRIPT, '--serve'],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, UV_HTTP_TIMEOUT: '180' } }
    );
    let settled = false;
    ps.once('error', (e) => { if (!settled) { settled = true; reject(e); } });
    ps.once('spawn', () => { if (!settled) { settled = true; resolve(ps); } });
  });
}

class RapidWorker {
  constructor() {
    this.proc = null;
    this.spawnPromise = null;
    this.buf = '';
    this.pending = new Map();
    this.nextId = 1;
    this.idleTimer = null;
  }

  async ensure() {
    if (this.proc && !this.proc.killed) return;
    if (this.spawnPromise) return this.spawnPromise;

    this.spawnPromise = (async () => {
      let lastErr;
      for (const uv of UV_CANDIDATES) {
        try {
          const ps = await spawnUv(uv);
          this.proc = ps;
          process.stderr.write(`[computer-use] ocr worker: ${uv}\n`);
          ps.stdout.setEncoding('utf8');
          ps.stderr.setEncoding('utf8');
          ps.stdout.on('data', (d) => this.#onData(d));
          ps.stderr.on('data', (d) => process.stderr.write('[rapid] ' + d));
          ps.on('exit', () => {
            for (const p of this.pending.values()) p.reject(new Error('ocr worker exited'));
            this.pending.clear();
            this.proc = null;
            this.spawnPromise = null;
          });
          return;
        } catch (e) {
          if (e.code === 'ENOENT') { lastErr = e; continue; }
          this.spawnPromise = null;
          throw e;
        }
      }
      this.spawnPromise = null;
      throw new Error(`uv not found (tried ${UV_CANDIDATES.join(', ')}): ${lastErr?.message}`);
    })();

    await this.spawnPromise;
  }

  #onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(Buffer.from(line, 'base64').toString('utf8')); } catch { continue; }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error));
    }
  }

  /** 每次使用后重置空闲计时器；到点就退出释放内存 */
  #armIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      process.stderr.write(`[computer-use] ocr worker idle ${OCR_IDLE_MS}ms, releasing memory\n`);
      this.stop();
    }, OCR_IDLE_MS);
    this.idleTimer.unref?.();
  }

  async call(pngPath, ox, oy, timeoutMs = 60000) {
    await this.ensure();
    const id = this.nextId++;
    const payload = Buffer.from(JSON.stringify({ id, png: pngPath, ox, oy }), 'utf8').toString('base64');
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ocr worker timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.proc.stdin.write(payload + '\n');
    });
    this.#armIdleTimer();
    return result;
  }

  stop() {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const p = this.proc;
    this.proc = null;
    this.spawnPromise = null;
    if (!p) return;
    try { p.stdin.end(); } catch { /* ignore */ }
    try { p.kill(); } catch { /* ignore */ }
  }
}

const rapidWorker = new RapidWorker();

async function runRapidOcr(pngPath, ox, oy) {
  return rapidWorker.call(pngPath, ox, oy);
}

tool('ocr', {
  title: 'OCR a screen region',
  description:
    'Recognise text in a screen region (or the whole screen) and return the text plus the bounding box of ' +
    'every word. Use this when the UI exposes no accessibility tree (canvas, games, web content) or when ' +
    'small text must be read exactly. Boxes are screen coordinates, so a recognised word can be clicked ' +
    'directly. Engine "rapidocr" (default) is PaddleOCR models on ONNXRuntime — much better on Chinese and ' +
    'large glyphs than the built-in "windows" engine.',
  inputSchema: {
    x: z.number().int().optional().describe('Region left edge; omit for the whole screen'),
    y: z.number().int().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    engine: z.enum(['rapidocr', 'windows']).optional().describe('Default rapidocr'),
    filter: z.string().optional().describe('Return only words containing this substring'),
    max_words: z.number().int().min(1).max(2000).optional().describe('Default 200'),
    scale: z.number().min(0.2).max(1).optional()
      .describe('Windows engine only: downscale before OCR'),
  },
  annotations: READ_ONLY,
}, async ({ x, y, width, height, engine, filter, max_words, scale }) => {
  const region = x !== undefined && y !== undefined && width && height;
  let r;
  if ((engine ?? 'rapidocr') === 'windows') {
    const args = [];
    if (region) args.push('-X', String(x), '-Y', String(y), '-W', String(width), '-H', String(height));
    if (scale !== undefined && scale !== 1) args.push('-Scale', String(scale));
    r = await runWindowsOcr(args);
  } else {
    const shot = await host.call('save_png', region ? { x, y, width, height } : {});
    try {
      r = await runRapidOcr(shot.path, region ? x : 0, region ? y : 0);
      r.region = [region ? x : 0, region ? y : 0, shot.width, shot.height];
    } finally {
      try { await (await import('node:fs/promises')).unlink(shot.path); } catch { /* ignore */ }
    }
  }
  let words = r.words || [];
  if (filter) words = words.filter((w) => w.t.includes(filter));
  const total = words.length;
  words = words.slice(0, max_words ?? 200);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        region: r.region,
        ms: r.ms,
        totalWords: total,
        returned: words.length,
        text: r.text,
        words,
      }, null, 2),
    }],
  };
});

/* ---- 策略与审计层 -----------------------------------------------------
 * "控制真机" 和 "完全隔离" 架构上互斥 —— Codex 能隔离，是因为它控制的是
 * 沙箱里的桌面而不是你的。所以这里做的是**压缩爆炸半径**：
 *
 *   1. 黑名单：拒绝把输入送进密码管理器 / 银行 / 支付类窗口
 *   2. 白名单（可选）：只允许操作指定进程
 *   3. 审计：每个动作连同目标窗口写进 audit.jsonl，事后可查
 *   4. 速率限制：防止跑飞
 *
 * 判定目标用的是 WindowFromPoint —— 点击真正落在哪个窗口上，而不是猜。
 * ------------------------------------------------------------------- */

const POLICY_PATH = process.env.COMPUTER_USE_POLICY ?? path.join(HERE, 'policy.json');
const AUDIT_PATH = process.env.COMPUTER_USE_AUDIT ?? path.join(HERE, 'audit.jsonl');

const DEFAULT_POLICY = {
  deny_processes: [
    'keepass', 'keepassxc', '1password', 'bitwarden', 'lastpass', 'dashlane',
    'nordpass', 'keeper', 'enpass', 'authenticator', 'windowssecurity',
    'metamask', 'exodus', 'ledgerlive', 'trezor', 'electrum',
    'regedit', 'diskmgmt', 'diskpart', 'gpedit', 'compmgmt', 'certmgr', 'mmc',
  ],
  deny_window_titles: [
    '密码', 'password', '凭据', 'credential', '助记词', 'seed phrase',
    '银行', 'bank', '支付', 'pay', '钱包', 'wallet', '转账', 'transfer',
    '两步验证', '2fa', 'otp', '验证码',
    '用户账户控制', 'user account control',
  ],
  approval_processes: [
    'weixin', 'wechat', 'qq', 'telegram', 'discord', 'whatsapp', 'signal',
    'slack', 'teams', 'dingtalk', '飞书', 'feishu', 'lark',
    'outlook', 'thunderbird', 'foxmail',
    'mstsc', 'teamviewer', 'anydesk', 'todesk', 'sunflower', 'vnc', 'rustdesk',
  ],
  approval_window_titles: [
    '发送', 'send', '远程桌面', 'remote desktop', '远程控制', 'remote control',
  ],
  allow_processes: [],           // 非空时：只允许操作这些进程
  max_actions_per_minute: 120,
  audit: true,
};

let policy = { ...DEFAULT_POLICY };

function loadPolicy() {
  try {
    if (!existsSync(POLICY_PATH)) return;
    const raw = JSON.parse(readFileSync(POLICY_PATH, 'utf8'));
    policy = { ...DEFAULT_POLICY, ...raw };
    process.stderr.write(`[computer-use] policy loaded: ${POLICY_PATH}\n`);
  } catch (e) {
    process.stderr.write(`[computer-use] policy ignored (${e.message}), using defaults\n`);
  }
}
loadPolicy();

/** 会产生副作用的工具 */
const MUTATING = new Set([
  'mouse_move', 'click', 'drag', 'scroll', 'type_text', 'key', 'hold_key',
  'clipboard_write', 'launch_app', 'click_element',
]);

const rateLog = [];
function rateExceeded() {
  const now = Date.now();
  while (rateLog.length && now - rateLog[0] > 60000) rateLog.shift();
  if (rateLog.length >= policy.max_actions_per_minute) return true;
  rateLog.push(now);
  return false;
}

function matchesAny(haystack, needles) {
  const h = String(haystack ?? '').toLowerCase();
  return needles.find((n) => h.includes(String(n).toLowerCase())) ?? null;
}

function denied(reason, detail, hint) {
  return {
    isError: true,
    content: [{
      type: 'text',
      text: JSON.stringify({ blocked_by_policy: true, reason, detail, hint }, null, 2),
    }],
  };
}

/** 解析动作的目标窗口（只对会产生副作用的工具做） */
async function resolveTarget(name, args) {
  if (!MUTATING.has(name)) return null;
  try {
    // 坐标类动作：WindowFromPoint 精确判定点击落在谁身上
    if (typeof args?.x === 'number' && typeof args?.y === 'number') {
      return await host.call('window_at', { x: args.x, y: args.y });
    }
    // 语义点击：目标窗口可能不是前台窗口，必须先找到元素再判定
    if (name === 'click_element') {
      const idx = args?.index ?? 0;
      const found = await host.call('find_elements', {
        name: args?.name, control_type: args?.control_type,
        automation_id: args?.automation_id, class_name: args?.class_name,
        window: args?.window, max: idx + 1,
      });
      const el = found?.elements?.[idx];
      if (el?.center) {
        return await host.call('window_at', { x: el.center[0], y: el.center[1] });
      }
    }
    return await host.call('active_window');
  } catch (e) {
    process.stderr.write(`[policy] target lookup failed: ${e.message}\n`);
    return null;
  }
}

function policyGuard(name, args, target) {
  if (!MUTATING.has(name)) return null;
  if (!guardEnabled()) return null;          // 总开关关闭：黑名单与速率限制都跳过

  if (target && target.found !== false) {
    const proc = target.process ?? '';
    const title = target.title ?? '';

    const badProc = matchesAny(proc, policy.deny_processes);
    if (badProc) {
      return denied('target process is on the deny list',
        { process: proc, title, matched: badProc }, `Edit ${POLICY_PATH} to allow it.`);
    }
    const badTitle = matchesAny(title, policy.deny_window_titles);
    if (badTitle) {
      return denied('target window title looks sensitive',
        { process: proc, title, matched: badTitle }, `Edit ${POLICY_PATH} to allow it.`);
    }
    if (policy.allow_processes.length && !matchesAny(proc, policy.allow_processes)) {
      return denied('target process is not on the allow list',
        { process: proc, title, allow: policy.allow_processes }, `Edit ${POLICY_PATH} to allow it.`);
    }
  }

  if (rateExceeded()) {
    return denied('rate limit exceeded',
      { max_actions_per_minute: policy.max_actions_per_minute }, 'Wait a minute or raise the limit.');
  }

  return null;
}

async function audit(name, args, result, target) {
  if (!auditEnabled()) return;
  try {
    const line = JSON.stringify({
      t: new Date().toISOString(),
      op: name,
      args,
      target: target ? { process: target.process, title: target.title } : undefined,
      ok: !result?.isError,
    });
    appendFileSync(AUDIT_PATH, line + '\n');
  } catch { /* 审计失败不影响主流程 */ }
}

/* ---- 弹窗审批 ---------------------------------------------------------
 * 危险动作弹一个真实对话框，MCP 服务端阻塞等它的退出码。
 * 只有人手点击才能放行 —— 模型伪造不了。
 *
 * 开关是**用户侧的文件**，不是 MCP 工具：否则模型能自己关掉。
 * 删除/创建 .approval-off 即可临时关闭/恢复。
 * ------------------------------------------------------------------- */

const APPROVAL_SCRIPT = path.join(HERE, 'approval.ps1');
const APPROVAL_FLAG = path.join(HERE, '.approval-off');
const GUARD_FLAG = path.join(HERE, '.guard-off');        // 总开关：关闭全部防护
const AUDIT_FLAG = path.join(HERE, '.audit-off');

/** 总开关：关闭后黑名单与速率限制停用（弹窗、审计各自独立） */
function guardEnabled() {
  return !existsSync(GUARD_FLAG);
}

function approvalEnabled() {
  if (existsSync(APPROVAL_FLAG)) return false;
  return policy.approval?.enabled !== false;
}

function auditEnabled() {
  if (existsSync(AUDIT_FLAG)) return false;
  return policy.audit !== false;
}

function describeTarget(t) {
  if (!t || t.found === false) return '(target unknown)';
  const proc = t.process ?? '?';
  const title = t.title ?? '';
  return title ? `${proc}  |  ${title}` : proc;
}

/** 把工具参数压成一行，让人看清楚到底要做什么 */
function describeArgs(args) {
  if (!args) return '(none)';
  const parts = [];
  for (const [k, v] of Object.entries(args)) {
    if (k === 'confirm') continue;              // 内部参数，不展示
    let s = typeof v === 'string' ? v : JSON.stringify(v);
    if (s && s.length > 96) s = s.slice(0, 93) + '...';
    parts.push(`${k}=${s}`);
  }
  return parts.length ? parts.join(',  ') : '(none)';
}

/** 会话级"记住"：同一次运行内不再重复询问同一个 工具+目标 组合 */
const sessionApprovals = new Set();
const approvalKey = (name, target) =>
  `${name}|${target?.process ?? ''}|${target?.title ?? ''}`;

function spawnApproval(shell, params, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (code) => { if (!done) { done = true; clearTimeout(timer); resolve(code); } };
    let ps;
    try {
      // windowsHide MUST be false: it maps to STARTUPINFO.wShowWindow = SW_HIDE,
      // which hides the dialog itself (the script still runs and times out, so
      // the failure looks like "user never answered").
      ps = spawn(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', APPROVAL_SCRIPT, ...params],
                 { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { return resolve(3); }
    ps.stdout.setEncoding('utf8');
    ps.stderr.setEncoding('utf8');
    ps.stdout.on('data', (d) => process.stderr.write('[approval] ' + d));
    ps.stderr.on('data', (d) => process.stderr.write('[approval!] ' + d));
    const timer = setTimeout(() => { try { ps.kill(); } catch { /* ignore */ } finish(3); }, timeoutMs + 10000);
    ps.on('error', () => finish(3));
    ps.on('exit', (code) => finish(code));
  });
}

async function requestApproval(name, args, check, target) {
  const timeoutMs = policy.approval?.timeout_ms ?? 30000;
  const params = [
    '-Action', String(name),
    '-Target', describeTarget(target),
    '-Detail', describeArgs(args),
    '-Reason', String(check.reason ?? ''),
    '-TimeoutMs', String(timeoutMs),
  ];
  for (const shell of SHELL_CANDIDATES) {
    const code = await spawnApproval(shell, params, timeoutMs);
    if (code === 4) {                       // 允许 + 本次会话记住
      sessionApprovals.add(approvalKey(name, target));
      return 0;
    }
    if (code !== 3) return code;            // 0 allow / 1 deny / 2 timeout
  }
  return 3;                                 // 三个 shell 都起不来
}

function approvalDenied(name, args, check, code) {
  const outcome = code === 2 ? 'timed out (auto-denied)'
                : code === 3 ? 'approval dialog unavailable'
                : 'the user denied it';
  return {
    isError: true,
    content: [{
      type: 'text',
      text: JSON.stringify({
        denied_by_approval: true,
        outcome,
        action: name,
        arguments: args,
        reason: check.reason,
      }, null, 2),
    }],
  };
}

/* ---- 安全闸门 ---------------------------------------------------------
 * 危险动作默认不执行，而是回一个 pending_safety_check，要求再调一次并显式
 * 传 confirm: true。这和 OpenAI CUA 的 pending_safety_checks 是同一个思路：
 * 让调用方（和背后的人）有机会在看清楚之后再放行。
 * ------------------------------------------------------------------- */

const DANGER_KEY_COMBOS = [
  /alt\+f4/i, /ctrl\+w/i, /^win\+/i, /ctrl\+alt\+del/i, /ctrl\+shift\+esc/i,
  /shift\+delete/i, /^delete$/i, /^del$/i,
];
const DANGER_NAMES = [
  /关闭|删除|卸载|格式化|关机|重启|注销|清空|移除|发送|提交|支付|确认|同意/,
  /\b(close|delete|remove|uninstall|shutdown|restart|format|send|submit|pay|confirm|discard|empty|trash)\b/i,
];

function safetyCheck(name, args) {
  if (args?.confirm === true) return null;      // explicitly confirmed

  if (name === 'key' || name === 'hold_key') {
    const combo = String(args?.combo ?? args?.key ?? '');
    for (const re of DANGER_KEY_COMBOS) {
      if (re.test(combo)) {
        return { reason: `key combo "${combo}" is destructive`, pattern: String(re) };
      }
    }
  }

  if (name === 'click_element') {
    const target = `${args?.name ?? ''} ${args?.automation_id ?? ''} ${args?.window ?? ''}`;
    for (const re of DANGER_NAMES) {
      if (re.test(target)) return { reason: `target looks destructive: "${target.trim()}"`, pattern: String(re) };
    }
  }

  if (name === 'click' && args?.button === 'right') {
    return { reason: 'right-click opens a context menu with destructive entries' };
  }

  return null;
}

/**
 * 是否需要人工审批。两个来源：
 *   1. 动作本身的危险模式（safetyCheck）
 *   2. 目标进程/窗口在"必须审批"名单里 —— 例如微信、邮件、远程桌面：
 *      在那些地方一次误击就收不回来，所以任何动作都先问一声。
 */
function needsApproval(name, args, target) {
  const patternCheck = safetyCheck(name, args);
  if (patternCheck) return patternCheck;

  if (!MUTATING.has(name)) return null;
  if (!target || target.found === false) return null;

  const proc = matchesAny(target.process, policy.approval_processes ?? []);
  if (proc) {
    return { reason: `process "${target.process}" always requires approval`, pattern: proc };
  }
  const title = matchesAny(target.title, policy.approval_window_titles ?? []);
  if (title) {
    return { reason: `window title "${target.title}" always requires approval`, pattern: title };
  }
  return null;
}

function pendingCheck(name, args, check) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        pending_safety_check: true,
        action: name,
        arguments: args,
        reason: check.reason,
        matched: check.pattern,
        how_to_proceed: 'Re-issue the same call with confirm: true after the user agrees.',
      }, null, 2),
    }],
  };
}

/* ---- 语义定位（UI Automation） ---------------------------------------
 * 坐标会因窗口移动/分辨率变化而静默失效；控件树不会。
 * 标准 Win32 / UIA 应用优先用这组工具，canvas 类自绘 UI 再退回截图+坐标。
 * ------------------------------------------------------------------- */

const ELEM_QUERY = {
  name: z.string().optional().describe('Case-insensitive substring of the element name/label'),
  control_type: z.string().optional()
    .describe('button | edit | text | checkbox | combobox | listitem | menuitem | tabitem | ...'),
  automation_id: z.string().optional().describe('Exact AutomationId'),
  class_name: z.string().optional().describe('Exact Win32 class name'),
  window: z.string().optional()
    .describe('Title substring of the window to search in; defaults to the foreground window. ' +
              'Specifying it is much faster on a cold call (a huge tree like a browser can take ~1.3s ' +
              'to enumerate the first time; UIA caches it afterwards).'),
};

tool('find_elements', {
  title: 'Find UI elements',
  description:
    'Search the accessibility tree for controls matching name/type/id. Returns name, control type, ' +
    'automationId, class, enabled, offscreen, rect and center for each match. Use this instead of ' +
    'guessing coordinates: it either finds the element or tells you it is not there.',
  inputSchema: { ...ELEM_QUERY, max: z.number().int().min(1).max(200).optional().describe('Default 25') },
  annotations: READ_ONLY,
}, async (args) => json(await host.call('find_elements', { ...args, max: args.max ?? 25 })));

tool('click_element', {
  title: 'Click a UI element',
  description:
    'Find a control by name/type/id and activate it — InvokePattern when the control supports it, ' +
    'otherwise a mouse click at its center. Prefer this over click(x, y).',
  inputSchema: { ...ELEM_QUERY, index: z.number().int().min(0).optional().describe('Which match, default 0'),
    confirm: z.boolean().optional().describe('Set true to proceed after a pending_safety_check') },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}, async (args) => json(await host.call('click_element', { ...args, index: args.index ?? 0 })));

tool('ui_tree', {
  title: 'Dump UI tree',
  description:
    'Compact indented dump of a window\'s accessibility tree (control type, name, automationId). ' +
    'Use it to discover what an app exposes before searching for elements.',
  inputSchema: {
    window: z.string().optional().describe('Title substring; defaults to the foreground window'),
    depth: z.number().int().min(1).max(12).optional().describe('Default 4'),
    max_nodes: z.number().int().min(1).max(3000).optional().describe('Default 400'),
  },
  annotations: READ_ONLY,
}, async ({ window, depth, max_nodes }) =>
  json(await host.call('ui_tree', { window, depth: depth ?? 4, max_nodes: max_nodes ?? 400 }, 60000)));

tool('launch_app', {
  title: 'Launch an application',
  description:
    'Start an app, document or URL the way the Run dialog would (shell execute). Optionally wait until a ' +
    'window whose title matches appears, detected via the accessibility tree rather than pixel polling.',
  inputSchema: {
    target: z.string().describe('Executable, app alias ("calc.exe"), document path, or URL'),
    arguments: z.string().optional().describe('Command-line arguments'),
    window: z.string().optional().describe('Title substring to wait for'),
    wait_ms: z.number().int().min(0).max(30000).optional().describe('Max wait for that window (default 0)'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async ({ target, arguments: args, window, wait_ms }) =>
  json(await host.call('launch_app', { target, arguments: args, window, wait_ms: wait_ms ?? 0 },
    (wait_ms ?? 0) + 15000)));

tool('clipboard_write', {
  title: 'Write clipboard',
  description: 'Put text on the clipboard. Useful when typing into an app that mangles direct input.',
  inputSchema: { text: z.string() },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ text: s }) => { await host.call('clipboard_write', { text: s }); return text('clipboard updated'); });

tool('wait', {
  title: 'Wait',
  description: 'Sleep for a number of milliseconds — use between an action and the screenshot that verifies it.',
  inputSchema: { ms: z.number().int().min(1).max(30000) },
  annotations: READ_ONLY,
}, async ({ ms }) => { await host.call('wait', { ms }); return text(`waited ${ms}ms`); });

/* ------------------------------------------------------------------ 启动 */
const transport = new StdioServerTransport();
await server.connect(transport);

const shutdown = () => { rapidWorker.stop(); host.dispose(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => { rapidWorker.stop(); host.dispose(); });
