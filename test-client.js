/**
 * 独立测试客户端：直接和 computer-use-mcp 说 JSON-RPC，不经过 DSH。
 * 用法: node test-client.js [phase]
 *   phase=read   只读工具（无副作用）
 *   phase=notepad 端到端：激活窗口 → 点击 → 输入 Unicode 文本 → 校验
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const phase = process.argv[2] || 'read';

const child = spawn(process.execPath, [path.join(HERE, 'server.js')], {
  stdio: ['pipe', 'pipe', 'inherit'],
  windowsHide: true,
});

let buf = '';
const waiters = new Map();
child.stdout.setEncoding('utf8');
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const w = waiters.get(msg.id);
    if (w) { waiters.delete(msg.id); w(msg); }
  }
});

let id = 0;
function rpc(method, params) {
  const myId = ++id;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  return new Promise((res, rej) => {
    const t = setTimeout(() => { waiters.delete(myId); rej(new Error(`timeout: ${method}`)); }, 120000);
    waiters.set(myId, (m) => { clearTimeout(t); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); });
  });
}
const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');

async function call(name, args = {}) {
  const t0 = Date.now();
  const r = await rpc('tools/call', { name, arguments: args });
  const ms = Date.now() - t0;
  const blocks = (r.content || []).map((c) => (c.type === 'image' ? `[image ${Math.round(c.data.length / 1024)}KB]` : c.text));
  return { ms, isError: !!r.isError, text: blocks.join(' | ') };
}

const line = (label, r) =>
  console.log(`${r.isError ? '✗' : '✓'} ${label.padEnd(22)} ${String(r.ms).padStart(6)}ms  ${r.text.slice(0, 160)}`);

async function main() {
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'probe', version: '1' },
  });
  console.log(`server: ${init.serverInfo.name} ${init.serverInfo.version}  protocol ${init.protocolVersion}`);
  notify('notifications/initialized', {});

  const tools = await rpc('tools/list', {});
  console.log(`tools: ${tools.tools.length}`);
  console.log('  ' + tools.tools.map((t) => t.name).join(', '));
  console.log('');

  if (phase === 'read') {
    line('cursor_position', await call('cursor_position'));
    line('list_displays', await call('list_displays'));
    line('active_window', await call('active_window'));
    const w = await call('list_windows');
    line('list_windows', w);
    line('clipboard_read', await call('clipboard_read'));
    line('screenshot(full)', await call('screenshot'));
    line('zoom(400x200)', await call('zoom', { x: 200, y: 200, width: 400, height: 200 }));
    line('wait(120)', await call('wait', { ms: 120 }));

    // 鼠标移动往返（不点击）
    const before = JSON.parse((await call('cursor_position')).text);
    await call('mouse_move', { x: before.x + 3, y: before.y + 3 });
    const after = JSON.parse((await call('cursor_position')).text);
    await call('mouse_move', { x: before.x, y: before.y });
    console.log(
      `✓ ${'mouse_move'.padEnd(22)} ${String('').padStart(6)}      ${before.x},${before.y} -> ${after.x},${after.y} -> restored  ` +
      `${after.x === before.x + 3 && after.y === before.y + 3 ? 'OK' : 'MISMATCH'}`
    );
    line('scroll(1 up)', await call('scroll', { direction: 'up', amount: 1 }));
    line('scroll(1 down)', await call('scroll', { direction: 'down', amount: 1 }));
  }

  if (phase === 'notepad') {
    const { spawn: sp, execSync } = await import('node:child_process');
    const beforeList = JSON.parse((await call('list_windows')).text);
    const before = new Set((beforeList.value ?? beforeList).map((w) => w.handle));

    sp('notepad.exe', [], { detached: true, stdio: 'ignore' }).unref();

    // Win11 的 notepad.exe 会把窗口移交给另一个进程，pid 对不上，
    // 所以按“窗口列表的前后差异”来定位新窗口。
    let win = null;
    for (let i = 0; i < 40; i++) {
      await call('wait', { ms: 300 });
      const w = JSON.parse((await call('list_windows')).text);
      const arr = w.value ?? w;
      win = arr.find((x) => !before.has(x.handle) && /notepad|记事本/i.test(x.title));
      if (win) break;
    }
    if (!win) { console.log('✗ notepad window never appeared'); child.kill(); process.exit(1); }
    console.log(`   new window: "${win.title}" pid=${win.pid} rect=${JSON.stringify(win.rect)}`);

    line('activate_window(pid)', await call('activate_window', { pid: win.pid }));

    const aw = JSON.parse((await call('active_window')).text);
    const cx = Math.round((aw.rect[0] + aw.rect[2]) / 2);
    const cy = Math.round((aw.rect[1] + aw.rect[3]) / 2);
    line('click(center)', await call('click', { x: cx, y: cy }));

    const payload = "DSH MCP test: it's ok | 中文测试 🎋";
    line('type_text', await call('type_text', { text: payload }));

    // 用剪贴板回读做严格比对（记事本标题不显示正文，不可靠）
    line('key(ctrl+a)', await call('key', { combo: 'ctrl+a' }));
    line('key(ctrl+c)', await call('key', { combo: 'ctrl+c' }));
    await call('wait', { ms: 250 });
    const cb = JSON.parse((await call('clipboard_read')).text).text;
    const ok = cb === payload;
    console.log(`${ok ? '✓' : '✗'} ${'roundtrip verify'.padEnd(22)} ${String('').padStart(6)}      ` +
      `got="${cb}"`);
    if (!ok) console.log(`   expected="${payload}"`);

    line('key(ctrl+z)', await call('key', { combo: 'ctrl+z' }));
    line('drag(titlebar)', await call('drag', {
      x1: cx, y1: aw.rect[1] + 14, x2: cx + 60, y2: aw.rect[1] + 14,
    }));

    try { execSync(`taskkill /PID ${win.pid} /F`, { stdio: 'ignore' }); } catch { /* already gone */ }
    console.log('   notepad closed');
  }

  if (phase === 'advanced') {
    // 事件驱动：先取指纹，等它变，再取一次
    const h1 = await call('screen_hash');
    console.log(`   screen_hash #1: ${h1.text.trim()} (${h1.ms}ms)`);

    const w = await call('wait_for_change', { timeout_ms: 1500, interval_ms: 80 });
    console.log(`   wait_for_change: ${w.ms}ms -> ${w.text.replace(/\s+/g, ' ')}`);

    const h2 = await call('screen_hash');
    console.log(`   screen_hash #2: ${h2.text.trim()} (${h2.ms}ms)`);

    // batch：一次调用里做 多步 + 截图
    const b = await call('batch', {
      steps: [
        { op: 'cursor_position' },
        { op: 'wait', args: { ms: 50 } },
        { op: 'zoom', args: { x: 0, y: 0, width: 300, height: 160, format: 'png' } },
        { op: 'list_displays' },
      ],
    });
    console.log(`\n   batch: ${b.ms}ms, ${b.isError ? 'ERROR' : 'ok'}`);
    console.log('   ' + b.text.slice(0, 300).replace(/\n/g, ' '));
  }

  if (phase === 'uia') {
    const win = process.argv[3] || 'DeepSeek Harness';

    const t = await call('ui_tree', { window: win, depth: 3, max_nodes: 45 });
    console.log(`\n--- ui_tree("${win}") ${t.ms}ms ---`);
    try {
      const parsed = JSON.parse(t.text);
      console.log(`nodes=${parsed.nodes}`);
      console.log(parsed.tree.split('\n').slice(0, 20).join('\n'));
    } catch { console.log(t.text.slice(0, 700)); }

    const f = await call('find_elements', { window: win, control_type: 'button', max: 8 });
    console.log(`\n--- find_elements(buttons) ${f.ms}ms ---`);
    try {
      const parsed = JSON.parse(f.text);
      console.log(`count=${parsed.count}`);
      for (const e of parsed.elements) {
        console.log(`  ${e.controlType} "${e.name}" center=${JSON.stringify(e.center)} enabled=${e.enabled}`);
      }
    } catch { console.log(f.text.slice(0, 600)); }
  }

  if (phase === 'newtools') {
    // 1. 安全闸门：危险动作应当被拦下，且不执行
    const blocked = await call('key', { combo: 'alt+f4' });
    console.log(`\n--- key(alt+f4) 未确认 ---`);
    console.log('  ' + blocked.text.replace(/\s+/g, ' ').slice(0, 220));

    const blocked2 = await call('click_element', { name: '关闭', window: '计算器' });
    console.log(`\n--- click_element(name="关闭") 未确认 ---`);
    console.log('  ' + blocked2.text.replace(/\s+/g, ' ').slice(0, 220));

    // 2. launch_app：启动并等窗口出现
    const launch = await call('launch_app', { target: 'calc.exe', window: '计算器', wait_ms: 10000 });
    console.log(`\n--- launch_app(calc.exe) ${launch.ms}ms ---`);
    console.log('  ' + launch.text.replace(/\s+/g, ' ').slice(0, 220));

    // 3. OCR：对着计算器窗口取字
    await call('wait', { ms: 800 });
    const ocr = await call('ocr', { x: 60, y: 30, width: 560, height: 480, max_words: 25 });
    console.log(`\n--- ocr(计算器区域) ${ocr.ms}ms ---`);
    try {
      const o = JSON.parse(ocr.text);
      console.log(`  region=${JSON.stringify(o.region)} capture=${o.ms.capture}ms ocr=${o.ms.ocr}ms words=${o.totalWords}`);
      console.log(`  text: ${String(o.text).replace(/\s+/g, ' ').slice(0, 160)}`);
      for (const w of o.words.slice(0, 8)) console.log(`    "${w.t}" box=${JSON.stringify(w.box)}`);
    } catch { console.log(ocr.text.slice(0, 400)); }

    // 4. 用 OCR 的结果直接点一个字 —— 关掉计算器
    const ocr2 = await call('ocr', { x: 400, y: 30, width: 200, height: 200, max_words: 30 });
    try {
      const o = JSON.parse(ocr2.text);
      const close = o.words.find((w) => /关|Close|X/.test(w.t));
      if (close) {
        const [cx, cy, cw, ch] = close.box;
        const r = await call('click', { x: cx + cw / 2, y: cy + ch / 2 });
        console.log(`\n--- OCR 定位 "关闭" 并点击 box=${JSON.stringify(close.box)} -> ${r.isError ? 'ERR' : 'ok'}`);
      } else {
        console.log(`\n--- OCR 没找到关闭按钮（words: ${o.words.map(w=>w.t).join(' ')}）`);
      }
    } catch (e) { console.log('  ocr2 failed: ' + e.message); }
  }

  if (phase === 'rapid') {
    const launch = await call('launch_app', { target: 'calc.exe', window: '计算器', wait_ms: 10000 });
    console.log(`launch_app: ${launch.text.replace(/\s+/g, ' ').slice(0, 120)}`);
    await call('wait', { ms: 900 });

    // 之前 Windows OCR 完全读不出来的那片按钮区
    const R = { x: 60, y: 520, width: 500, height: 310 };
    for (const engine of ['windows', 'rapidocr']) {
      const r = await call('ocr', { ...R, engine, max_words: 30 });
      console.log(`\n--- engine=${engine}  ${r.ms}ms ---`);
      if (r.isError) { console.log('  ERROR: ' + r.text.slice(0, 200)); continue; }
      const o = JSON.parse(r.text);
      console.log(`  words=${o.totalWords}  ms=${JSON.stringify(o.ms)}`);
      console.log(`  text: ${String(o.text).slice(0, 200)}`);
      console.log('  boxes: ' + o.words.slice(0, 10).map((w) => `${w.t}@[${w.box.join(',')}]`).join('  '));
    }

    // 用 RapidOCR 找到的数字按钮点一下，验证 OCR 驱动的点击
    const r2 = await call('ocr', { ...R, engine: 'rapidocr', max_words: 30 });
    const o2 = JSON.parse(r2.text);
    const seven = o2.words.find((w) => w.t.trim() === '7');
    if (seven) {
      const [bx, by, bw, bh] = seven.box;
      const click = await call('click', { x: bx + bw / 2, y: by + bh / 2 });
      console.log(`\n--- OCR 定位 "7" box=${JSON.stringify(seven.box)} 点击 -> ${click.isError ? 'ERR' : 'ok'}`);
      const shot = await call('zoom', { x: 85, y: 170, width: 480, height: 150, format: 'png' });
      console.log(`    验证截图 ${shot.ms}ms（见图片）`);
    } else {
      console.log(`\n--- 没找到 "7"（识别到: ${o2.words.map((w) => w.t).join(' ')}）`);
    }

    // 收尾
    await call('click', { x: 515, y: 73 });
  }

  if (phase === 'policy') {
    // 用当前策略实测：点击计算器按钮
    const w = await call('click', { x: 134, y: 723 });
    console.log(`\n--- click 计算器按钮 ---`);
    console.log('  ' + (w.isError ? 'BLOCKED' : 'allowed') + '  ' + w.text.replace(/\s+/g, ' ').slice(0, 200));

    // 只读工具不应被策略影响
    const cp = await call('cursor_position');
    console.log(`\n--- cursor_position（只读，应不受策略影响）---`);
    console.log('  ' + (cp.isError ? 'BLOCKED' : 'allowed'));

    // 看一眼审计日志
    const { readFileSync, existsSync } = await import('node:fs');
    const p = path.join(HERE, 'audit.jsonl');
    if (existsSync(p)) {
      const lines = readFileSync(p, 'utf8').trim().split('\n').slice(-6);
      console.log(`\n--- audit.jsonl 最后 ${lines.length} 条 ---`);
      for (const l of lines) {
        const e = JSON.parse(l);
        console.log(`  ${e.t.slice(11, 19)}  ${e.op.padEnd(16)} ${(e.target?.process ?? '-').padEnd(22)} ok=${e.ok}`);
      }
    } else {
      console.log('\n  (没有 audit.jsonl)');
    }
  }

  child.kill();
  process.exit(0);
}

main().catch((e) => { console.error('FATAL', e); child.kill(); process.exit(1); });
