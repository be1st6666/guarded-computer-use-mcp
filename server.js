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
 *
 * 安全层拆在 src/ 下，各自可单测：
 *   src/guard.js     四个开关的签名标记文件（伪造/手改的标记一律忽略并告警）
 *   src/policy.js    黑名单 / 白名单 / 速率 / 危险模式判定
 *   src/audit.js     审计日志（脱敏 + 哈希链 + 轮转）
 *   src/approval.js  人工审批弹窗 + 弹窗期间的输入工具互斥锁
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { ROOT } from './src/paths.js';
import { SHELL_CANDIDATES } from './src/shell.js';
import { host, HOST_SCRIPT } from './src/host.js';
import { rapidWorker, runRapidOcr, runWindowsOcr } from './src/ocr.js';
import * as audit from './src/audit.js';
import * as guard from './src/guard.js';
import {
  MUTATING,
  getPolicy,
  reloadPolicy,
  policyLoadError,
  policyPath,
  auditEnabled,
  approvalEnabled,
  policyGuard,
  needsApproval,
  pendingCheck,
} from './src/policy.js';
import {
  gate,
  blockedWhileApprovalPending,
  requestApproval,
  approvalDenied,
  isSessionApproved,
  APPROVAL_SCRIPT,
} from './src/approval.js';

/* ------------------------------------------------------------------ MCP */
// 版本从 package.json 读，避免两处不一致
const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const server = new McpServer({ name: PKG.name, version: PKG.version }, { capabilities: { tools: {} } });

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const json = (v) => text(JSON.stringify(v, null, 2));

/** 统一包装：先过安全闸门，再把任何异常变成 MCP 的 isError 结果 */
const HANDLERS = new Map();

/* ------------------------------------------------------- 审计与告警接线 */

function auditOptions() {
  const a = getPolicy().audit;
  const o = a && typeof a === 'object' ? a : {};
  return {
    enabled: auditEnabled,
    redact: o.redact !== false,
    maxBytes: Number(o.max_bytes ?? process.env.COMPUTER_USE_AUDIT_MAX_BYTES ?? 16 * 1024 * 1024),
  };
}

function writeAudit(name, args, result, target) {
  audit.record({
    op: name,
    args,
    target: target ? { process: target.process ?? null, title: target.title ?? null } : null,
    ok: !result?.isError,
    note: result?.isError ? shortReason(result) : null,
  });
}

function shortReason(result) {
  try {
    const t = result?.content?.[0]?.text ?? '';
    const o = JSON.parse(t);
    return o.reason ?? o.outcome ?? null;
  } catch {
    return null;
  }
}

/** 新出现的篡改事件既写日志，也要让用户看见 */
let tamperSeen = 0;
function syncTamper() {
  const events = guard.tamperEvents_();
  if (events.length === tamperSeen) return;
  for (const e of events.slice(tamperSeen)) {
    audit.record({ op: 'guard_tamper', args: e, ok: false, note: 'unsigned or edited guard marker ignored' });
  }
  tamperSeen = events.length;
}

/** 把安全告警挂到结果前面，用户在对话里直接看到 */
function withNotices(result) {
  syncTamper();
  const warnings = [];
  const tamper = guard.tamperWarning();
  if (tamper) warnings.push(tamper);
  if (gate.lastFilter === 'unavailable') {
    warnings.push(
      'WARNING: the approval dialog could not install its injected-input filter; ' +
        'approvals are only protected by the server-side lock.',
    );
  }
  if (!warnings.length || !result) return result;
  return { ...result, content: [...warnings.map((w) => ({ type: 'text', text: w })), ...(result.content ?? [])] };
}

function tool(name, config, fn) {
  HANDLERS.set(name, fn);
  server.registerTool(name, config, async (args, extra) => {
    try {
      // 1. 弹窗期间的输入互斥：并行工具调用不能替用户按那个按钮
      const pre = blockedWhileApprovalPending(name);
      if (pre) {
        writeAudit(name, args, pre); // a refused attempt is evidence — log it
        return withNotices(pre);
      }

      const target = await resolveTarget(name, args);

      // 2. await 之后复查一次（目标解析也要 await，存在时间窗）
      const mid = blockedWhileApprovalPending(name);
      if (mid) {
        writeAudit(name, args, mid, target);
        return withNotices(mid);
      }

      // 3. 目标未知就 fail closed：两个名单都依赖"这个动作会落在哪个窗口上"，
      //    解析不出来时不能当作"没匹配"直接放行（那等于给了一条绕过名单的路）。
      //    默认转成待确认，只有调用方显式 confirm 才继续。
      if (MUTATING.has(name) && args?.confirm !== true && (!target || target.found === false)) {
        const pending = pendingCheck(
          name,
          args,
          {
            reason: 'the target window could not be resolved, so the deny lists cannot be applied',
            pattern: 'target-unknown',
            source: 'unknown',
          },
          'unavailable',
        );
        writeAudit(name, args, pending, target);
        return withNotices(pending);
      }

      const blocked = policyGuard(name, args, target);
      if (blocked) {
        writeAudit(name, args, blocked, target);
        return withNotices(blocked);
      }

      const check = needsApproval(name, args, target);
      if (check) {
        if (isSessionApproved(name, target)) {
          // 用户在本会话里勾选了"记住这个目标"，直接放行
        } else if (approvalEnabled()) {
          const code = await requestApproval(name, args, check, target, describeForDialog);
          if (code !== 0) {
            const res = approvalDenied(name, args, check, code);
            writeAudit(name, args, res, target);
            return withNotices(res);
          }
          // 用户点了允许 —— 继续执行
        } else {
          const pending = pendingCheck(name, args, check, 'disabled');
          writeAudit(name, args, pending, target);
          return withNotices(pending);
        }
      }

      const res = await fn(args, extra);
      writeAudit(name, args, res, target);
      return withNotices(res);
    } catch (e) {
      const err = { isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] };
      writeAudit(name, args, err);
      return withNotices(err);
    }
  });
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/* ---- 观察 ---------------------------------------------------------- */

function shotContent(r) {
  const note = r.capturedWidth !== r.width ? ` (downscaled from ${r.capturedWidth}x${r.capturedHeight})` : '';
  const ms = r.ms
    ? ` capture ${r.ms.capture}ms scale ${r.ms.scale}ms encode ${r.ms.encode}ms b64 ${r.ms.base64}ms`
    : '';
  const kb = r.bytes ? ` ${Math.round(r.bytes / 1024)}KB` : '';
  return [
    { type: 'image', data: r.data, mimeType: r.mime },
    { type: 'text', text: `${r.width}x${r.height}${note}${kb}${ms}` },
  ];
}

const SHOT_OPTS = {
  max_side: z
    .number()
    .int()
    .min(0)
    .max(4000)
    .optional()
    .describe('Longest-side cap for the returned image (default 1600; 0 = native)'),
  format: z.enum(['jpeg', 'png']).optional().describe('Encoding (default jpeg: ~4x faster to encode)'),
  quality: z.number().int().min(1).max(100).optional().describe('JPEG quality (default 88)'),
  interp: z
    .enum(['nearest', 'bilinear', 'bicubic'])
    .optional()
    .describe('Downscale filter (default bilinear; bicubic is slower)'),
};

tool(
  'screenshot',
  {
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
  },
  async ({ x, y, width, height, ...opts }) => {
    const region = x !== undefined && y !== undefined && width && height;
    const r = await host.call('screenshot', {
      ...(region ? { x, y, width, height } : {}),
      ...opts,
    });
    return { content: shotContent(r) };
  },
);

tool(
  'zoom',
  {
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
  },
  async ({ x, y, width, height, ...opts }) => {
    const r = await host.call('screenshot', { x, y, width, height, ...opts });
    return { content: shotContent(r) };
  },
);

tool(
  'screen_hash',
  {
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
  },
  async ({ x, y, width, height }) => {
    const region = x !== undefined && y !== undefined && width && height;
    return json(await host.call('fingerprint', region ? { x, y, width, height } : {}));
  },
);

tool(
  'wait_for_change',
  {
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
  },
  async ({ timeout_ms, interval_ms, x, y, width, height }) => {
    const region = x !== undefined && y !== undefined && width && height;
    return json(
      await host.call(
        'wait_for_change',
        {
          timeout_ms: timeout_ms ?? 10000,
          interval_ms: interval_ms ?? 120,
          ...(region ? { x, y, width, height } : {}),
        },
        (timeout_ms ?? 10000) + 15000,
      ),
    );
  },
);

tool(
  'batch',
  {
    title: 'Batch actions in one call',
    description:
      'Run several actions in one round trip, e.g. [click, wait, screenshot] — the model makes ONE tool call ' +
      'and gets the post-action state back. Steps run in order; screenshots come back as images. ' +
      'Use step names from this server (screenshot, zoom, click, type_text, key, wait, activate_window, ...).',
    inputSchema: {
      steps: z
        .array(
          z.object({
            op: z.string().describe('Tool name, e.g. "click"'),
            args: z.record(z.string(), z.any()).optional(),
          }),
        )
        .min(1)
        .max(40),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  async ({ steps }) => {
    const content = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepArgs = step.args ?? {};
      const label = `#${i + 1} ${step.op}`;

      // 弹窗正在等人类决策时，整批停下（批里的注入动作同样能替用户按按钮）
      if (blockedWhileApprovalPending('batch') || blockedWhileApprovalPending(step.op)) {
        const refused = blockedWhileApprovalPending(step.op) ?? blockedWhileApprovalPending('batch');
        writeAudit(step.op, stepArgs, refused, null); // a refused attempt is evidence
        content.push({
          type: 'text',
          text: `${label}: BLOCKED — an approval dialog is waiting for a human; batch stops here`,
        });
        break;
      }

      const stepTarget = await resolveTarget(step.op, stepArgs);

      // 同一个 fail closed 规则：解析不出目标就不在批里执行这一步
      if (MUTATING.has(step.op) && stepArgs?.confirm !== true && (!stepTarget || stepTarget.found === false)) {
        const pending = pendingCheck(
          step.op,
          stepArgs,
          {
            reason: 'the target window could not be resolved, so the deny lists cannot be applied',
            pattern: 'target-unknown',
            source: 'unknown',
          },
          'unavailable',
        );
        writeAudit(step.op, stepArgs, pending, stepTarget);
        content.push({ type: 'text', text: `${label}: BLOCKED — target window could not be resolved (fail closed)` });
        continue;
      }

      // 黑名单对 batch 的每一步同样生效（此前 batch 完全绕过了 deny list）
      const blocked = policyGuard(step.op, stepArgs, stepTarget);
      if (blocked) {
        writeAudit(step.op, stepArgs, blocked, stepTarget);
        content.push({ type: 'text', text: `${label}: BLOCKED BY POLICY — ${shortReason(blocked) ?? 'denied'}` });
        continue;
      }

      const check = needsApproval(step.op, stepArgs, stepTarget);
      if (check) {
        // 批处理里不弹窗（会打断整批），直接跳过该步并说明原因
        content.push({
          type: 'text',
          text:
            `${label}: BLOCKED — ${check.reason} ` + `(run it as a separate call so the approval dialog can appear)`,
        });
        continue;
      }
      const fn = HANDLERS.get(step.op);
      if (!fn) {
        content.push({ type: 'text', text: `${label}: unknown tool` });
        continue;
      }
      const res = await fn(step.args ?? {}, {});
      writeAudit(step.op, stepArgs, res, stepTarget);
      if (res?.content) {
        // 图像块直接透传，文本块加序号前缀
        for (const c of res.content) {
          if (c.type === 'image') content.push(c);
          else content.push({ type: 'text', text: `${label}: ${c.text}` });
        }
      }
    }
    return { content };
  },
);

tool(
  'bench',
  {
    title: 'Benchmark capture pipeline',
    description: 'Time each stage of the screenshot pipeline across encoding/scale variants. Diagnostic only.',
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => json(await host.call('bench', {}, 120000)),
);

tool(
  'cursor_position',
  {
    title: 'Cursor position',
    description: 'Current mouse cursor position in physical pixels.',
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => json(await host.call('cursor_position')),
);

tool(
  'list_displays',
  {
    title: 'List displays',
    description: 'All monitors with their bounds in the virtual desktop coordinate space.',
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => json(await host.call('list_displays')),
);

tool(
  'list_windows',
  {
    title: 'List windows',
    description: 'All visible top-level windows with title, pid, minimized state and rect.',
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => json(await host.call('list_windows')),
);

tool(
  'active_window',
  {
    title: 'Active window',
    description: 'The foreground window (handle, pid, process name, title, rect).',
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => json(await host.call('active_window')),
);

tool(
  'clipboard_read',
  {
    title: 'Read clipboard',
    description: 'Read the clipboard as text.',
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => json(await host.call('clipboard_read')),
);

/* ---- 鼠标 ---------------------------------------------------------- */

tool(
  'mouse_move',
  {
    title: 'Move mouse',
    description: 'Move the cursor to (x, y) without clicking.',
    inputSchema: { x: z.number().int(), y: z.number().int() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ x, y }) => {
    await host.call('mouse_move', { x, y });
    return text(`moved to (${x}, ${y})`);
  },
);

tool(
  'click',
  {
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
  },
  async ({ x, y, button, count }) => {
    await host.call('click', { x, y, button: button ?? 'left', count: count ?? 1 });
    return text(`clicked ${button ?? 'left'} x${count ?? 1} at ${x === undefined ? 'cursor' : `(${x}, ${y})`}`);
  },
);

tool(
  'drag',
  {
    title: 'Drag',
    description: 'Press at (x1, y1), move to (x2, y2), release. The move is interpolated in steps for reliability.',
    inputSchema: {
      x1: z.number().int(),
      y1: z.number().int(),
      x2: z.number().int(),
      y2: z.number().int(),
      button: z.enum(['left', 'right', 'middle']).optional(),
      steps: z.number().int().min(2).max(200).optional().describe('Default: 24'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  async ({ x1, y1, x2, y2, button, steps }) => {
    await host.call('drag', { x1, y1, x2, y2, button: button ?? 'left', steps: steps ?? 24 });
    return text(`dragged (${x1}, ${y1}) -> (${x2}, ${y2})`);
  },
);

tool(
  'scroll',
  {
    title: 'Scroll',
    description: 'Scroll the wheel at (x, y) (moves the cursor there first when given). amount is in wheel notches.',
    inputSchema: {
      x: z.number().int().optional(),
      y: z.number().int().optional(),
      direction: z.enum(['up', 'down']).optional().describe('Default: down'),
      amount: z.number().int().min(1).max(50).optional().describe('Default: 3'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ x, y, direction, amount }) => {
    const r = await host.call('scroll', { x, y, direction: direction ?? 'down', amount: amount ?? 3 });
    return text(`scrolled ${direction ?? 'down'} ${Math.abs(r.notches)} notch(es)`);
  },
);

/* ---- 键盘 ---------------------------------------------------------- */

tool(
  'type_text',
  {
    title: 'Type text',
    description:
      'Type a string as Unicode keystrokes. Handles CJK, quotes, and emoji natively — no escaping needed. ' +
      'The target window must have keyboard focus.',
    inputSchema: { text: z.string().describe('Text to type') },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  async ({ text: s }) => {
    const r = await host.call('type_text', { text: s });
    return text(`typed ${r.chars} character(s)`);
  },
);

tool(
  'key',
  {
    title: 'Press key combination',
    description: 'Press a key or chord, e.g. "enter", "esc", "f5", "ctrl+c", "ctrl+shift+s", "alt+f4", "win+d".',
    inputSchema: {
      combo: z.string().describe('Key or "+"-joined chord'),
      confirm: z.boolean().optional().describe('Set true to proceed after a pending_safety_check'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  async ({ combo }) => {
    await host.call('key', { combo });
    return text(`pressed ${combo}`);
  },
);

tool(
  'hold_key',
  {
    title: 'Hold a key',
    description: 'Hold a key down for a duration (ms), e.g. to charge or repeat.',
    inputSchema: {
      key: z.string(),
      ms: z.number().int().min(1).max(10000),
      confirm: z.boolean().optional().describe('Set true to proceed after a pending_safety_check'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  async ({ key, ms }) => {
    await host.call('hold_key', { key, ms });
    return text(`held ${key} for ${ms}ms`);
  },
);

/* ---- 窗口 / 剪贴板 ------------------------------------------------- */

tool(
  'activate_window',
  {
    title: 'Activate window',
    description:
      'Bring a window to the foreground. Match by case-insensitive title substring, or by pid. ' +
      'A minimized window is restored first.',
    inputSchema: {
      title: z.string().optional().describe('Case-insensitive substring of the window title'),
      pid: z.number().int().positive().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ title, pid }) => {
    if (title === undefined && pid === undefined) throw new Error('provide title or pid');
    return json(await host.call('activate_window', { title, pid }));
  },
);

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

tool(
  'ocr',
  {
    title: 'OCR a screen region',
    description:
      'Recognise text in a screen region (or the whole screen) and return the text plus the bounding box of ' +
      'every word. Use this when the UI exposes no accessibility tree (canvas, games, web content) or when ' +
      'small text must be read exactly. Boxes are screen coordinates, so a recognised word can be clicked ' +
      'directly. Engine "rapidocr" (default) is PaddleOCR models on ONNXRuntime — much better on Chinese and ' +
      'large glyphs than the built-in "windows" engine. Latency scales with the number of recognised text ' +
      'boxes, so pass a region instead of the whole screen whenever you do not need all of it.',
    inputSchema: {
      x: z.number().int().optional().describe('Region left edge; omit for the whole screen'),
      y: z.number().int().optional(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      engine: z.enum(['rapidocr', 'windows']).optional().describe('Default rapidocr'),
      filter: z.string().optional().describe('Return only words containing this substring'),
      max_words: z.number().int().min(1).max(2000).optional().describe('Default 200'),
      scale: z.number().min(0.2).max(1).optional().describe('Windows engine only: downscale before OCR'),
    },
    annotations: READ_ONLY,
  },
  async ({ x, y, width, height, engine, filter, max_words, scale }) => {
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
        try {
          await (await import('node:fs/promises')).unlink(shot.path);
        } catch {
          /* ignore */
        }
      }
    }
    let words = r.words || [];
    if (filter) words = words.filter((w) => w.t.includes(filter));
    const total = words.length;
    words = words.slice(0, max_words ?? 200);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              region: r.region,
              ms: r.ms,
              totalWords: total,
              returned: words.length,
              text: r.text,
              words,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

/* ---- 策略与审计层 -----------------------------------------------------
 * "控制真机" 和 "完全隔离" 架构上互斥 —— Codex 能隔离，是因为它控制的是
 * 沙箱里的桌面而不是你的。所以这里做的是**压缩爆炸半径**：
 *
 *   1. 黑名单：拒绝把输入送进密码管理器 / 银行 / 支付类窗口
 *   2. 白名单（可选）：只允许操作指定进程
 *   3. 审计：每个动作连同目标窗口写进 audit.jsonl（已脱敏 + 哈希链）
 *   4. 速率限制：防止跑飞
 *   5. 审批弹窗：危险动作阻塞等真人点击，弹窗期间输入工具互斥
 *
 * 判定目标用的是 WindowFromPoint —— 点击真正落在哪个窗口上，而不是猜。
 * ------------------------------------------------------------------- */

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
        name: args?.name,
        control_type: args?.control_type,
        automation_id: args?.automation_id,
        class_name: args?.class_name,
        window: args?.window,
        max: idx + 1,
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
    if (k === 'confirm') continue; // 内部参数，不展示
    let s = typeof v === 'string' ? v : JSON.stringify(v);
    if (s && s.length > 96) s = s.slice(0, 93) + '...';
    parts.push(`${k}=${s}`);
  }
  return parts.length ? parts.join(',  ') : '(none)';
}

const describeForDialog = { describeTarget, describeArgs };

/* ---- 语义定位（UI Automation） ---------------------------------------
 * 坐标会因窗口移动/分辨率变化而静默失效；控件树不会。
 * 标准 Win32 / UIA 应用优先用这组工具，canvas 类自绘 UI 再退回截图+坐标。
 * ------------------------------------------------------------------- */

const ELEM_QUERY = {
  name: z.string().optional().describe('Case-insensitive substring of the element name/label'),
  control_type: z
    .string()
    .optional()
    .describe('button | edit | text | checkbox | combobox | listitem | menuitem | tabitem | ...'),
  automation_id: z.string().optional().describe('Exact AutomationId'),
  class_name: z.string().optional().describe('Exact Win32 class name'),
  window: z
    .string()
    .optional()
    .describe(
      'Title substring of the window to search in; defaults to the foreground window. ' +
        'Specifying it is much faster on a cold call (a huge tree like a browser can take ~1.3s ' +
        'to enumerate the first time; UIA caches it afterwards).',
    ),
};

tool(
  'find_elements',
  {
    title: 'Find UI elements',
    description:
      'Search the accessibility tree for controls matching name/type/id. Returns name, control type, ' +
      'automationId, class, enabled, offscreen, rect and center for each match. Use this instead of ' +
      'guessing coordinates: it either finds the element or tells you it is not there.',
    inputSchema: { ...ELEM_QUERY, max: z.number().int().min(1).max(200).optional().describe('Default 25') },
    annotations: READ_ONLY,
  },
  async (args) => json(await host.call('find_elements', { ...args, max: args.max ?? 25 })),
);

tool(
  'click_element',
  {
    title: 'Click a UI element',
    description:
      'Find a control by name/type/id and activate it — InvokePattern when the control supports it, ' +
      'otherwise a mouse click at its center. Prefer this over click(x, y).',
    inputSchema: {
      ...ELEM_QUERY,
      index: z.number().int().min(0).optional().describe('Which match, default 0'),
      confirm: z.boolean().optional().describe('Set true to proceed after a pending_safety_check'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  async (args) => json(await host.call('click_element', { ...args, index: args.index ?? 0 })),
);

tool(
  'ui_tree',
  {
    title: 'Dump UI tree',
    description:
      "Compact indented dump of a window's accessibility tree (control type, name, automationId). " +
      'Use it to discover what an app exposes before searching for elements.',
    inputSchema: {
      window: z.string().optional().describe('Title substring; defaults to the foreground window'),
      depth: z.number().int().min(1).max(12).optional().describe('Default 4'),
      max_nodes: z.number().int().min(1).max(3000).optional().describe('Default 400'),
    },
    annotations: READ_ONLY,
  },
  async ({ window, depth, max_nodes }) =>
    json(await host.call('ui_tree', { window, depth: depth ?? 4, max_nodes: max_nodes ?? 400 }, 60000)),
);

tool(
  'launch_app',
  {
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
  },
  async ({ target, arguments: args, window, wait_ms }) =>
    json(
      await host.call('launch_app', { target, arguments: args, window, wait_ms: wait_ms ?? 0 }, (wait_ms ?? 0) + 15000),
    ),
);

tool(
  'clipboard_write',
  {
    title: 'Write clipboard',
    description: 'Put text on the clipboard. Useful when typing into an app that mangles direct input.',
    inputSchema: { text: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ text: s }) => {
    await host.call('clipboard_write', { text: s });
    return text('clipboard updated');
  },
);

tool(
  'wait',
  {
    title: 'Wait',
    description: 'Sleep for a number of milliseconds — use between an action and the screenshot that verifies it.',
    inputSchema: { ms: z.number().int().min(1).max(30000) },
    annotations: READ_ONLY,
  },
  async ({ ms }) => {
    await host.call('wait', { ms });
    return text(`waited ${ms}ms`);
  },
);

/* ------------------------------------------------------------------ 启动 */

/** 启动信息写进审计：策略路径、开关状态、密钥来源、篡改事件 */
function auditStartup() {
  const state = guard.switchState(); // 触发一次读取，发现篡改
  audit.record({
    op: 'session_start',
    args: {
      pid: process.pid,
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      cwd: process.cwd(),
      server: `${PKG.name}@${PKG.version}`,
      hostScript: path.basename(HOST_SCRIPT),
      approvalScript: path.basename(APPROVAL_SCRIPT),
      shells: SHELL_CANDIDATES,
      policyPath: policyPath(),
      policyLoadError: policyLoadError(),
      guards: state,
      guardSecret: guard.secretStatus(),
      audit: auditOptions(),
    },
  });
  syncTamper();
}

reloadPolicy();
audit.configure(auditOptions());
auditStartup();

const transport = new StdioServerTransport();
await server.connect(transport);

const shutdown = () => {
  audit.record({ op: 'session_end', args: { pid: process.pid } });
  rapidWorker.stop();
  host.dispose();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => {
  rapidWorker.stop();
  host.dispose();
});
