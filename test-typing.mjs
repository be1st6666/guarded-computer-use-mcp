// 验证 type_text 的换行/制表符处理，以及 activate_window 真的把窗口提到前台。
//
// 背景：这两个 bug 是往 GitHub 的 Release 表单里填多行文本时发现的 ——
//   1. type_text 把 '\n' 当普通 Unicode 字符发出去，浏览器不认，换行全丢了
//   2. activate_window 调用 SetForegroundWindow 后被 Windows 静默拒绝，
//      键击其实发给了别的窗口
//
// 用法: node test-typing.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

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
    try { m = JSON.parse(line); } catch { continue; }
    const w = waiters.get(m.id);
    if (w) { waiters.delete(m.id); w(m.result); }
  }
});
const rpc = (method, params) => {
  const my = ++id;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: my, method, params }) + '\n');
  return new Promise((res) => waiters.set(my, res));
};
const call = (name, args) => rpc('tools/call', { name, arguments: args ?? {} });
const textOf = (r) => (r.content || []).filter((x) => x.controlType !== 'image' && x.type === 'text').map((x) => x.text).join('');

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'typing-test', version: '1' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

let failed = 0;

// --- 1. activate_window 必须真的把窗口提到前台 ---
await call('launch_app', { target: 'notepad.exe', window: 'Notepad', wait_ms: 10000 });
await call('wait', { ms: 800 });

const act = await call('activate_window', { title: 'Notepad' });
const actInfo = JSON.parse(textOf(act));
await call('wait', { ms: 600 });
const nowActive = JSON.parse(textOf(await call('active_window', {})));

if (actInfo.foreground && nowActive.process?.toLowerCase() === 'notepad') {
  console.log('PASS  activate_window -> foreground (verified via active_window)');
} else {
  console.log(`FAIL  activate_window reported foreground=${actInfo.foreground}, active=${nowActive.process}`);
  failed++;
}

// --- 2. type_text 必须保住换行和制表符 ---
await call('key', { combo: 'ctrl+a' });
await call('key', { combo: 'delete' });
await call('wait', { ms: 300 });

const sent = 'line one\nline two\nline three\ttabbed';
await call('type_text', { text: sent });
await call('wait', { ms: 800 });

await call('key', { combo: 'ctrl+a' });
await call('key', { combo: 'ctrl+c' });
await call('wait', { ms: 600 });

const got = JSON.parse(textOf(await call('clipboard_read', {}))).text ?? '';
const normalized = String(got).replace(/\r\n/g, '\n');
if (normalized === sent) {
  console.log('PASS  type_text -> newlines and tabs preserved (clipboard round-trip)');
} else {
  console.log('FAIL  type_text lost formatting');
  console.log('  sent: ' + JSON.stringify(sent));
  console.log('  got : ' + JSON.stringify(normalized));
  failed++;
}

// --- 3. 清理 ---
await call('key', { combo: 'ctrl+a' });
await call('key', { combo: 'delete' });

console.log(`\n${failed === 0 ? 'all typing tests passed' : failed + ' failed'}`);
child.kill();
process.exit(failed ? 1 : 0);
