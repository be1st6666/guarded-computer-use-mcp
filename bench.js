/**
 * 性能基准：逐 op 测延迟 + 返回体积（token 成本的代理指标）。
 * 只跑只读 op，无副作用。
 * 用法: node bench.js [reps]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPS = Number(process.argv[2] || 10);

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
    const l = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!l) continue;
    let m;
    try { m = JSON.parse(l); } catch { continue; }
    const w = waiters.get(m.id);
    if (w) { waiters.delete(m.id); w(m); }
  }
});
const rpc = (method, params) => {
  const my = ++id;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: my, method, params }) + '\n');
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + method)), 120000);
    waiters.set(my, (m) => { clearTimeout(t); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); });
  });
};
const notify = (m, p) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: m, params: p }) + '\n');

async function call(name, args = {}) {
  const t0 = process.hrtime.bigint();
  const r = await rpc('tools/call', { name, arguments: args });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  let bytes = 0;
  let imgs = 0;
  let dim = null;
  for (const c of r.content || []) {
    if (c.type === 'image') { bytes += c.data.length; imgs++; }
    else if (c.type === 'text') {
      bytes += c.text.length;
      const m = c.text.match(/(\d{2,5})x(\d{2,5})/);
      if (m && !dim) dim = [Number(m[1]), Number(m[2])];
    }
  }
  return { ms, bytes, imgs, dim, isError: !!r.isError };
}

// token 估算：图像按 (w*h)/750（业界经验公式），文本按 4 字符/token
const imgTokens = (w, h) => Math.round((w * h) / 750);
const txtTokens = (chars) => Math.round(chars / 4);

function stats(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return {
    min: s[0],
    p50: s[Math.floor(s.length / 2)],
    max: s[s.length - 1],
  };
}

const CASES = [
  { label: 'cursor_position', op: 'cursor_position', args: {} },
  { label: 'list_windows', op: 'list_windows', args: {} },
  { label: 'active_window', op: 'active_window', args: {} },
  { label: 'screen_hash (64x40 指纹)', op: 'screen_hash', args: {} },
  { label: 'screenshot full 1600x1000', op: 'screenshot', args: { max_side: 1600 } },
  { label: 'screenshot full 900x562', op: 'screenshot', args: { max_side: 900 } },
  { label: 'zoom region 480x150', op: 'zoom', args: { x: 85, y: 170, width: 480, height: 150, format: 'png' } },
  { label: 'find_elements (8 buttons)', op: 'find_elements', args: { control_type: 'button', max: 8 } },
  { label: 'ui_tree depth=3', op: 'ui_tree', args: { depth: 3, max_nodes: 45 } },
  { label: 'ocr rapidocr (region)', op: 'ocr', args: { x: 60, y: 520, width: 500, height: 310, engine: 'rapidocr', max_words: 20 } },
  { label: 'wait_for_change (300ms)', op: 'wait_for_change', args: { timeout_ms: 300, interval_ms: 100 } },
  { label: 'batch: 3 ops + 1 shot', op: 'batch', args: { steps: [
      { op: 'cursor_position' }, { op: 'wait', args: { ms: 30 } },
      { op: 'screen_hash' }, { op: 'screenshot', args: { max_side: 900 } },
    ] } },
];

async function main() {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bench', version: '1' } });
  notify('notifications/initialized', {});

  console.log(`每个 op 跑 ${REPS} 次（首次含 C# 编译，单独标注）\n`);
  console.log('op                              first     p50      max     bytes  ~tokens  图');
  console.log('-'.repeat(84));

  const results = [];
  for (const c of CASES) {
    const times = [];
    let last = null;
    for (let i = 0; i < REPS; i++) {
      const r = await call(c.op, c.args);
      times.push(r.ms);
      last = r;
    }
    const st = stats(times);
    const tok = last.imgs && last.dim ? imgTokens(last.dim[0], last.dim[1]) : txtTokens(last.bytes);
    console.log(
      c.label.padEnd(30) +
      `${Math.round(times[0])}ms`.padStart(7) +
      `${Math.round(st.p50)}ms`.padStart(8) +
      `${Math.round(st.max)}ms`.padStart(8) +
      `${Math.round(last.bytes / 1024)}KB`.padStart(9) +
      `~${tok}`.padStart(9) +
      `${last.imgs}`.padStart(4)
    );
    results.push({ ...c, ...st, bytes: last.bytes, tokens: tok, imgs: last.imgs, dim: last.dim });
  }

  console.log('\n=== 一次「看→做→验证」循环的成本模型 ===');
  const shot = results.find((r) => r.label.includes('1600x1000'));
  const small = results.find((r) => r.label.includes('900x562'));
  const region = results.find((r) => r.label.includes('zoom'));
  const hash = results.find((r) => r.label.includes('screen_hash'));
  const uia = results.find((r) => r.label.includes('find_elements'));
  const line = (name, r) => console.log(
    `${name.padEnd(16)} ${String(Math.round(r.p50) + 'ms').padStart(7)}  ~${String(r.tokens).padStart(5)} tokens`
  );
  line('全屏截图', shot);
  line('半分辨率截图', small);
  line('区域截图', region);
  line('屏幕指纹', hash);
  line('UIA 找控件', uia);
  console.log(`\n指纹 vs 全屏截图：token 便宜 ${Math.round(shot.tokens / hash.tokens)} 倍`);
  console.log(`UIA 文本 vs 全屏截图：token 便宜 ${(shot.tokens / uia.tokens).toFixed(1)} 倍`);

  child.kill();
  process.exit(0);
}

main().catch((e) => { console.error('FATAL', e); child.kill(); process.exit(1); });
