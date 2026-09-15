// 验证 type_text 的换行/制表符处理，以及 activate_window 真的把窗口提到前台。
//
// 背景：这两个 bug 是往 GitHub 的 Release 表单里填多行文本时发现的 ——
//   1. type_text 把 '\n' 当普通 Unicode 字符发出去，浏览器不认，换行全丢了
//   2. activate_window 调用 SetForegroundWindow 后被 Windows 静默拒绝，
//      键击其实发给了别的窗口
//
// 安全约束（2026-09-15 修）：本测试**只操作自己创建的临时文件窗口**。
//   旧版本用 activate_window({title:'Notepad'}) 子串匹配，会劫持你已经打开的
//   记事本窗口，然后 ctrl+a + delete 清空内容 —— 换行/制表符这个用例本来就
//   需要先清空，代价是可能删掉你正在编辑的文档。现在：
//     * 自己建一个空临时文件，用它唯一的文件名作为窗口匹配串；
//     * 每次输入前都校验**当前前台窗口标题**含这个唯一串，否则中止；
//     * 再也不用 delete（空文件不需要清空），只用 ctrl+a / ctrl+c；
//     * 结束时只关自己那个窗口，且仅当该进程没有别的窗口时才结束进程。
//
// 用法: node test-typing.mjs
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 现有记事本进程（PID）。我们只允许结束"自己启动出来的"那些。 */
const notepadPids = () => {
  const out =
    spawnSync('tasklist', ['/FI', 'IMAGENAME eq notepad.exe', '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    }).stdout ?? '';
  return new Set(
    out
      .split('\n')
      .map((l) => /^"notepad\.exe","(\d+)"/i.exec(l.trim()))
      .filter(Boolean)
      .map((m) => m[1]),
  );
};

const pidsBefore = notepadPids();
if (pidsBefore.size > 0) {
  // 记事本可能用同一个进程/窗口承载多个标签页。这种情况下无法保证"只动自己那个
  // 窗口"，所以宁可不测，也不去碰你正在编辑的文档。
  console.log(
    `SKIP  Notepad is already running (pid ${[...pidsBefore].join(', ')}) — ` +
      'close it first; this test refuses to type into a window it did not open',
  );
  process.exit(0);
}

const child = spawn(process.execPath, [path.join(HERE, 'server.js')], {
  stdio: ['pipe', 'pipe', 'inherit'],
  windowsHide: true,
});
let buf = '';
const waiters = new Map();
let id = 0;
child.stdout.setEncoding('utf8');
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    const w = waiters.get(m.id);
    if (w) {
      waiters.delete(m.id);
      w(m.result);
    }
  }
});
const rpc = (method, params) => {
  const my = ++id;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: my, method, params }) + '\n');
  return new Promise((res) => waiters.set(my, res));
};
const call = (name, args) => rpc('tools/call', { name, arguments: args ?? {} });
const textOf = (r) =>
  (r.content || [])
    .filter((x) => x.controlType !== 'image' && x.type === 'text')
    .map((x) => x.text)
    .join('');
const jsonOf = async (name, args) => JSON.parse(textOf(await call(name, args)));

await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'typing-test', version: '2' },
});
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

let failed = 0;

/* ---------------------------------------------------- 一次性的临时文档 */
const workDir = mkdtempSync(path.join(tmpdir(), 'gcu-typing-'));
const docPath = path.join(workDir, `gcu-typing-${process.pid}.txt`);
writeFileSync(docPath, ''); // 空文件：不需要清空，也就不需要 delete
const marker = path.basename(docPath);

/** 当前前台窗口是否真的是我们这个临时文档 */
async function foregroundIsOurs() {
  const active = await jsonOf('active_window', {});
  const title = String(active.title ?? '');
  return { ok: title.includes(marker), title, process: String(active.process ?? '') };
}

/** 反复激活直到目标窗口真的在前台，并且确实是我们那个临时文档 */
async function ensureForeground(tries = 4) {
  for (let i = 0; i < tries; i++) {
    const info = await jsonOf('activate_window', { title: marker });
    await call('wait', { ms: 500 });
    const active = await foregroundIsOurs();
    if (info.foreground && active.ok) return { info, active };
  }
  return null;
}

// --- 1. activate_window 必须真的把窗口提到前台 ---
await call('launch_app', { target: docPath, window: marker, wait_ms: 10000 });
await call('wait', { ms: 1200 });

const fg = await ensureForeground();
if (fg) {
  console.log(`PASS  activate_window -> foreground (verified: ${fg.active.title})`);
} else {
  const active = await foregroundIsOurs();
  console.log(`FAIL  the temp document never reached the foreground (active: ${active.title || '(none)'})`);
  failed++;
}

// --- 2. type_text 必须保住换行和制表符 ---
const sent = 'line one\nline two\nline three\ttabbed';
let normalized = '';
let aborted = false;

// 输入前/复制前各确认一次焦点。Windows 11 的记事本会用标签页复用窗口，
// 加上后台进程偶尔抢焦点，这一步能挡掉大部分环境抖动。
for (let attempt = 1; attempt <= 3 && !aborted; attempt++) {
  if (!(await ensureForeground())) {
    console.log('FAIL  lost the foreground before typing — aborting instead of typing elsewhere');
    failed++;
    aborted = true;
    break;
  }
  await call('type_text', { text: sent });
  await call('wait', { ms: 900 });

  if (!(await ensureForeground())) {
    console.log('FAIL  lost the foreground before copying — aborting');
    failed++;
    aborted = true;
    break;
  }
  await call('key', { combo: 'ctrl+a' });
  await call('key', { combo: 'ctrl+c' });
  await call('wait', { ms: 700 });

  const got = (await jsonOf('clipboard_read', {})).text ?? '';
  normalized = String(got).replace(/\r\n/g, '\n');
  if (normalized === sent) break;
  if (attempt < 3) console.log(`      (attempt ${attempt} came back as ${JSON.stringify(normalized)}, retrying)`);
}

if (aborted) {
  // 已经计入失败，不再重复计数
} else if (normalized === sent) {
  console.log('PASS  type_text -> newlines and tabs preserved (clipboard round-trip)');
} else {
  console.log('FAIL  type_text lost formatting');
  console.log('  sent: ' + JSON.stringify(sent));
  console.log('  got : ' + JSON.stringify(normalized));
  failed++;
}

// --- 3. 清理：只结束"我们启动出来的"记事本进程（启动前后 PID 差集） ---
try {
  const started = [...notepadPids()].filter((p) => !pidsBefore.has(p));
  for (const pid of started) {
    spawnSync('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore' });
  }
  if (started.length === 0) console.log('note: no Notepad process of ours to close (already exited)');
} catch {
  /* 清理失败不影响结论 */
}
rmSync(workDir, { recursive: true, force: true });

console.log(`\n${failed === 0 ? 'all typing tests passed' : failed + ' failed'}`);
child.kill();
process.exit(failed ? 1 : 0);
