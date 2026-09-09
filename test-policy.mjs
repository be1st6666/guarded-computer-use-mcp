// 黑名单/审批名单的匹配自测：不实际操作，只看判定结果。
import { readFileSync } from 'node:fs';

const policy = JSON.parse(readFileSync(new URL('./policy.json', import.meta.url), 'utf8'));
const m = (h, n) => {
  const s = String(h ?? '').toLowerCase();
  return n.find((x) => s.includes(String(x).toLowerCase())) ?? null;
};

const shouldHit = [
  ['deny_processes', '1Password', '密码管理器'],
  ['deny_processes', 'KeePassXC', '密码管理器'],
  ['deny_processes', 'Bitwarden', '密码管理器'],
  ['deny_processes', 'MetaMask', '加密钱包'],
  ['deny_processes', 'Ledger Live', '加密钱包'],
  ['deny_processes', 'regedit', '注册表编辑器'],
  ['deny_processes', 'diskmgmt', '磁盘管理'],
  ['deny_processes', 'diskpart', '分区工具'],
  ['deny_window_titles', '网上银行 - 转账', '网银页面'],
  ['deny_window_titles', 'Chrome - 密码管理器', '浏览器密码页'],
  ['deny_window_titles', '输入验证码', '验证码页'],
  ['deny_window_titles', 'User Account Control', 'UAC'],
  ['approval_processes', 'Weixin', '微信'],
  ['approval_processes', 'Telegram', 'Telegram'],
  ['approval_processes', 'OUTLOOK', '邮件'],
  ['approval_processes', 'mstsc', '远程桌面'],
  ['approval_processes', 'TeamViewer', '远程控制'],
  ['approval_processes', 'DingTalk', '钉钉'],
  ['approval_window_titles', '发送消息', '发送按钮'],
];

const shouldMiss = [
  ['deny_processes', 'notepad', '记事本'],
  ['deny_processes', 'CalculatorApp', '计算器'],
  ['deny_processes', 'chrome', '浏览器'],
  ['deny_processes', 'Code', 'VS Code'],
  ['deny_processes', 'blender', 'Blender'],
  ['deny_window_titles', 'Display settings', '显示设置'],
  ['deny_window_titles', 'Untitled - Notepad', '记事本窗口'],
  ['deny_window_titles', 'DeepSeek Harness', 'DSH'],
  ['approval_processes', 'chrome', '浏览器'],
  ['approval_processes', 'notepad', '记事本'],
];

let ok = 0;
let bad = 0;

console.log('--- 应当命中 ---');
for (const [list, val, label] of shouldHit) {
  const hit = m(val, policy[list]);
  const good = !!hit;
  if (good) ok++; else bad++;
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${label.padEnd(14)} "${val}"` + (hit ? `  -> "${hit}"` : '  -> MISS'));
}

console.log('\n--- 不应误伤 ---');
for (const [list, val, label] of shouldMiss) {
  const hit = m(val, policy[list]);
  const good = !hit;
  if (good) ok++; else bad++;
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${label.padEnd(14)} "${val}"` + (hit ? `  -> false positive "${hit}"` : ''));
}

console.log(`\n${ok} passed, ${bad} failed`);
console.log(`\n列表规模: deny_processes=${policy.deny_processes.length} deny_titles=${policy.deny_window_titles.length} approval_processes=${policy.approval_processes.length} approval_titles=${policy.approval_window_titles.length}`);
process.exit(bad ? 1 : 0);
