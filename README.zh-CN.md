# guarded-computer-use-mcp

[English](README.md) · 中文

**给智能体一双手，但不交出钥匙。**

Windows 桌面控制 MCP 服务：**危险动作会停下来等真人点击**。26 个工具：截图、鼠标、键盘、UI Automation、OCR、窗口、剪贴板。

**没有任何第三方自动化代码**——所有能力由本目录的 `host.ps1`（C# + Win32）实现，唯一依赖是官方的 `@modelcontextprotocol/sdk`。

---

> [!WARNING]
> **这个服务会用你的用户权限、在你的真实桌面上操作你的鼠标和键盘。没有沙箱，也没有撤销。**
>
> 它能以你的身份发消息、删文件、读取你屏幕上的一切——而**读到的东西会传给你的模型供应商**。
>
> 审批闸门和策略名单只能**压缩爆炸半径，不能消除它**。把智能体接上来之前，请先读
> **[风险与免责](#风险与免责)**。

---

## 为什么

多数 computer use 工具是把键盘塞给模型，然后祈祷。模型误点进聊天窗口、邮件、付款页之前都没事——但**没有撤销**。

这个实现的做法是在危险的部分前面装一道门：

![审批弹窗](docs/approval-dialog.png)

MCP 服务端**阻塞**在这个弹窗上，用它的退出码决定放不放行。有三件互相独立的事，让模型没法自己回答自己的提问：

1. **门锁**——弹窗开着的时候，所有会注入输入的工具一律被拒绝（`refused_by_approval_gate`），而且**每个 `await` 之后都要再查一遍**（包括 `batch` 的每一步：解析该步目标之前和之后各查一次）。MCP 的工具处理函数是 async 的，没有这把锁，一个*并行*发生的工具调用（`key("alt+a")`、点「允许」的 `click(x, y)`）就能替人回答弹窗；`batch` 的步骤循环也可能在目标解析的几百毫秒里被一个并行调用抢先打开弹窗，然后照跑不误。**这曾经是一个真实的绕过**，回归测试是 `npm run test:inject` 和 `npm run test:lock`。
2. **同一时刻只弹一个窗**——第二个需要审批的调用会被直接拒绝（`refused_by_approval_gate`，`"only one is shown at a time"`），而不是叠一个新弹窗；否则第一个弹窗一关，锁就抬起来，而另一个还开着。
3. **弹窗只认物理事件**——弹窗装上底层键盘/鼠标钩子，丢掉每一个带 Windows `injected` 标志的事件，只接受钩子给出的放行（真人按的 Alt+A，或真人点在「允许」按钮里）。任何自动化工具发 `SendInput`、post 一个 `BM_CLICK` / `WM_SYSKEYDOWN`、或者走 UIAutomation 的 `InvokePattern`，都过不了这道检查，弹窗会把丢掉的注入事件次数显示出来。进程声明了 DPI 感知，所以钩子的坐标和「允许」按钮的矩形对得上，真人的点击不会被误判成合成输入。

```json
{ "refused_by_approval_gate": true,
  "reason": "an approval dialog is waiting for a human decision — input-injecting tools are refused until it is answered" }
```

被门锁挡住的是这些工具：`mouse_move`、`click`、`drag`、`scroll`、`type_text`、`key`、`hold_key`、`click_element`、`clipboard_write`、`launch_app`、`activate_window`、`batch`。

物理输入过滤管的是**这一个**弹窗：它不认注入的键鼠，也不认 post 过去的窗口消息，所以另一个本地进程没法用 UIAutomation `InvokePattern` 替人按「允许」。真正剩下的路是文件——见 [SECURITY.md](SECURITY.md) §4.1。

**设计上保证"误按键不可能放行"：**

| 按键 | 效果 |
|---|---|
| `Enter` | **无效**——故意不绑定 |
| `Esc` / 关闭按钮 | 拒绝 |
| `Alt+A` / 点「允许」 | 允许（只认物理输入） |
| 超时无应答 | 自动拒绝（界面显示倒计时） |

弹窗还会显示**真正要执行的参数**（`automationId=…`、`name=…`），跟随系统语言（中文/英文），有提示音，且始终置顶。勾选「本次会话内记住这个目标」后，同一个**动作**（元素名 / automationId / 坐标）加上它的目标在服务重启前不再询问；从"前台窗口兜底"得到的目标永远不会被记住。

退出码：`0` 允许一次 / `1` 拒绝 / `2` 超时自动拒绝 / `3` 弹窗不可用（退回 `pending_safety_check`）/ `4` 允许并记住本次会话。

不想被打断的时候随时关掉：

```
双击  guard-panel.cmd      # 面板：四个互相独立的开关
双击  toggle-approval.cmd  # 只快速切弹窗审批
```

开关是**带 HMAC 签名的标记文件**，服务端**每次调用都会重新读**——改完立即生效，不用重启：

| 开关 | 标记文件 | 关闭后 |
|---|---|---|
| 弹窗审批 | `.approval-off` | 危险动作返回 `pending_safety_check`，不再问你 |
| 黑名单拦截 | `.guard-off` | 黑名单、白名单和速率限制全部跳过 |
| 审计日志 | `.audit-off` | 不再写 `audit.jsonl` |
| 物理输入校验 | `.physical-off` | 弹窗重新接受注入的键鼠 |

四者互相独立：关掉黑名单**不会**顺手把弹窗也关掉。

标记用 `guard.key`（或启动者环境里的 `COMPUTER_USE_GUARD_SECRET`）签名，签名覆盖开关名、状态、时间戳和**每个开关各自的计数器**。**没有签名、被人手改过、或者重放的标记一律忽略**——防护保持打开（fail closed）——同时记进审计日志（`op=guard_tamper`）并出现在下一次工具返回里。所谓重放，就是把一个以前签过的旧标记恢复回去：已接受的最大计数器记在 `guard.state.json` 里，回滚不过去。每次启动还会把 `secretStatus().fingerprint` 写进审计日志，所以 `guard.key` 被掉包这件事在两次运行之间看得出来。`COMPUTER_USE_GUARD_SECRET` 不再被子进程继承（宿主 shell、OCR worker、审批弹窗，以及 `launch_app` 启动的任何程序都拿不到），`cmd /c set > file` 这条读密钥的路子被堵掉了。同一个用户身份既然能在这个目录里写文件，就也能读到、或者直接换掉 `guard.key`；[SECURITY.md](SECURITY.md) §4.2 讲了这件事诚实的一面。

面板和切换脚本背后调的就是 `node src/guard.js set <开关> on|off`。

![防护面板](docs/guard-panel.png)

---

## 防护分层

这里早已不是"三层防护"，现在是六层，外加一条速率限制：

| 层 | 做什么 | 模型能绕过吗 |
|---|---|---|
| **策略引擎**（`policy.json`） | 拒绝碰黑名单里的进程 / 窗口标题，也拒绝把 shell / LOLBin 当成 `launch_app` 的目标；可选白名单；速率限制。`batch` 的每一步同样要过 | 黑名单完全不看 `confirm`——硬拒绝。改 `policy.json` 等于把网眼改大 |
| **审批弹窗**（`approval.ps1`） | 危险动作 → 真弹窗 → 等人 | 只有**物理**的 Alt+A / 点击算数：`confirm` 不行，注入的输入不行，post 的 `BM_CLICK` / `WM_SYSKEYDOWN` 不行，UIA 的 `InvokePattern` 也不行；另一个弹窗开着的时候同样不放行 |
| **门锁**（`src/approval.js`） | 弹窗开着时拒绝所有注入输入的工具，每个 `await` 之后都复查（`batch` 的每一步、目标解析前后各一次）；第二个要审批的调用直接拒绝，不叠窗 | 不能——它是服务端状态 |
| **物理输入过滤** | 弹窗里的底层键鼠钩子丢掉带 `injected` 标志的事件，只认物理事件；丢了多少次会显示在弹窗上；进程是 DPI 感知的 | 不能——注入的键鼠、post 的窗口消息、UIA 的 `InvokePattern` 都会被丢弃并计数；钩子装不上会降级成普通按钮点击，并在工具返回里告警 |
| **签名开关**（`src/guard.js`） | 伪造、手改**或重放**的标记被忽略并上报；每个开关带计数器，已接受的水位记在 `guard.state.json`；`secretStatus().fingerprint` 每次启动写进审计日志 | 没有密钥伪造不出来、也重放不了；`guard.key` 对你的用户可读可换，水位文件也能被能写文件的人回滚 |
| **审计日志**（`audit.jsonl`） | 每个动作 + 目标进程，已脱敏，带 `prev`/`hash` 链和链头 `audit.head.json` | ——（只能事后发现改动：`npm run audit:verify` 能查出改记录 / 删尾部 / 删文件 / 抹掉 hash；把日志和链头一起重写的人查不出来） |

`confirm: true` **不是授权**。它只在审批弹窗被操作者主动关掉时才被接受（那是你自己的决定），而且对名单类审批从来无效；弹窗开着的时候，危险模式（`alt+f4`、右键、名字是「删除」/「发送」/「关闭」… 的 `click_element`）一律要过弹窗。

判定目标用 **`WindowFromPoint`**——点击**真正**落在哪个窗口上，不是当前前台窗口。没有坐标的动作（在光标处的 `click`、`scroll`）按**真实光标位置**判定，不再退回前台窗口；`drag` 的起点和落点都要查；`click` / `scroll` 只给 `x` 或只给 `y` 会被直接拒绝（宿主会把缺的那个当成 0，等于在一个从没查过的窗口里点击）。`launch_app` 的"目标"是它要启动的程序，那不是窗口，任何窗口名单都看不见它，所以按可执行文件名单独查一遍（`policy.json` 里的 `deny_launch_targets` 加上进程黑名单）：`cmd`、`powershell`、`mshta`、`rundll32`、`certutil` 这类 shell / LOLBin 一律拒绝。

```json
{ "blocked_by_policy": true, "reason": "target process is on the deny list",
  "detail": { "process": "ApplicationFrameHost", "title": "计算器",
              "matched": "applicationframehost" } }
```

### 名单里有什么

四张表，全部是子串匹配（大小写不敏感），都在 `policy.json` 里：

| 表 | 行为 | 默认覆盖 |
|---|---|---|
| `deny_processes`（49） | **硬拒绝，`confirm` 也覆盖不掉** | 密码管理器、加密钱包、`regedit`/`diskmgmt`/`diskpart`/`gpedit` |
| `deny_window_titles`（31） | **硬拒绝** | `password`、`bank`、`pay`、`wallet`、`转账`、`验证码`、助记词、UAC |
| `approval_processes`（32） | 每个动作都弹窗 | 通讯（微信/QQ/Telegram/Slack…）、邮件、远程桌面（RDP/TeamViewer/AnyDesk…） |
| `approval_window_titles`（8） | 每个动作都弹窗 | `send`、`发送`、`remote desktop` |

**为什么要拆成两档**：微信这类应用**不该被完全禁止**——你可能想让智能体读它、总结它——但**没有你点头，那里什么都不会被点**。

`npm run test:policy` 用 29 个样本验证这四张表，**误伤即失败**（浏览器、记事本、Blender 和本仓库自己的测试台都必须干净通过）。

### 审计日志

`audit.jsonl` 记下每个动作和它的目标进程。"直接 `appendFileSync(JSON.stringify(args))`" 有四个问题，现在都改了：

- **参数值脱敏**：`text`、`password`、`token` 这类看着就敏感的键（还有 `passwd` / `secret` / `apikey` / `cookie` / `otp` / `pin` …），值会被换成 `{redacted, chars, sha256[:12]}`——够你把事情对起来，不够把秘密泄露出去；`batch` 的步骤参数会递归进去一起处理。
- **窗口标题截断到 80 字符**。标题是日志里唯一留下的自由文本（"点的是哪个窗口"正是这份日志的意义）。想连标题都不留，在 `policy.json` 里写 `"audit": { "redact_titles": true }`，标题会被换成指纹。
- **按大小轮转**：单段超过上限就切成 `audit-<时间戳>.jsonl`，每一段各自起一条链。
- **逐条哈希链 + 链头**：每条记录都带 `prev`（上一条的 hash）和 `hash`；另外还有一份链头 `audit.head.json`，记下这一段走到哪儿了——没有它的话，"删掉尾部"和"整份删掉"都会被当成一条完好的短链。

`npm run audit:verify` 会把 `audit.jsonl`、所有轮转出来的分段和链头一起走一遍，所以**改过一条记录、删掉尾部、删掉整个文件、把 `hash` 字段抹掉**都能发现；哈希链存在之前写下的老记录照样报成 `legacy`，不算篡改（这样已有的日志可以直接升级）。把日志和链头一起重写的写入者仍然发现不了——这条链是"防篡改的证据"，不是"防篡改"。

---

## 安装

需要 **Windows 10/11** + **Node.js ≥ 18**：

```bash
git clone https://github.com/be1st6666/guarded-computer-use-mcp
cd guarded-computer-use-mcp
npm install
```

建议装 **PowerShell 7**（UTF-8 和 JSON 处理更好），没有会自动退回 Windows PowerShell 5.1。

**OCR 可选**：需要 [`uv`](https://docs.astral.sh/uv/) 在 PATH 里。没有它其它功能照常工作。

### 装完先自测

```bash
npm test              # 只读工具，无副作用，随时可跑
npm run test:unit     # 策略/开关/审计/审批核心的单元测试
npm run test:smoke    # MCP 握手 + 工具 schema，不需要桌面
npm run test:policy   # 黑名单/审批名单，29 个样本
npm run test:typing   # activate_window + 多行 type_text（会起记事本）
npm run test:inject   # 打开真弹窗，证明注入的输入回答不了它
npm run test:lock     # 协议层：并行工具调用答不了那个弹窗
npm run verify        # 所有不需要交互桌面的检查
```

`npm test` 每个工具打一个勾并给出耗时。能列出工具、`screenshot` 能返回图片，就说明接线正确。
`npm run test:inject` 和 `npm run test:lock` 会占用你的屏幕几秒钟（它们打开的是真弹窗），结束时都必须是 `all checks passed`。

### 接进你的 MCP 客户端

**Claude Desktop / Cursor / 任何 stdio 客户端**：

```json
{
  "mcpServers": {
    "computer": {
      "command": "node",
      "args": ["D:/path/to/guarded-computer-use-mcp/server.js"]
    }
  }
}
```

**DeepSeek Harness (DSH)** —— 加到 `$DSH_HOME/profiles/web/cordis.patch.yml`：

```yaml
- insert:
    - id: mcp-computer-use
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: computer
        transport: stdio
        command: C:/Program Files/nodejs/node.exe
        args:
          - D:/path/to/guarded-computer-use-mcp/server.js
        cwd: D:/path/to/guarded-computer-use-mcp
```

工具会以 `mcp__computer__<名字>` 出现。配置热重载，改完约 10 秒内重连。

---

## 性能（实测，2560×1600 屏，5–8 次取中位数）

| 操作 | 耗时 | 返回 token |
|---|---|---|
| `cursor_position` / `active_window` | **1ms** | 7–39 |
| `ui_tree` | **12ms** | 38 |
| `zoom` 区域 480×150 | **25ms** | **96** |
| `screen_hash` | **44ms** | **9** |
| `screenshot` 900×562 | **58ms** | 674 |
| `screenshot` 1600×1000 | **116ms** | 2133 |
| `batch`（3 步 + 一次截图） | **134ms**，一次往返 | 674 |
| `find_elements` | **209ms** | 640 |
| `ocr`（worker 已热） | **457ms** | 554 |

capture 的 ~55ms 是整屏 GPU→CPU 读回的物理下限，GDI 路径没法再降。想再快只能上 DXGI Desktop Duplication，代价是 native addon。

OCR 的耗时跟着**识别出的文本框数量**走，跟截图区域大小无关：文字密集的整屏 2560×1600 实测 **~6.9s / 105 个框**，1280×800 的区域 **~3.3s / 45 个框**（约 2 倍）。先把图缩小**没有用**——RapidOCR 的检测器内部会把输入归一到固定尺寸，预缩放只丢精度、几乎不省时间；一次塞进去更多框也是更慢不是更快。所以不需要整屏的时候，**传区域**（`x`/`y`/`width`/`height`）。

### token 成本

一张整屏截图约 2133 token，这几个替代品便宜得多：

| 不整屏截图，改用 | token | 省 |
|---|---|---|
| `screen_hash`——"屏幕变了吗？" | 9 | **237×** |
| `zoom`——只看你要的那块 | 96 | 22× |
| `find_elements`——要文字，不要像素 | 640 | 3.3× |

`batch` 还能把 N 个动作压进**一次模型回合**，这才是大头：一次模型推理要 2–10 秒，一次工具调用只要 1–457ms。

---

## 三级定位（UIA / OCR / 截图）

坐标法有个致命缺陷：**点错了不会告诉你**。窗口一移动、分辨率一变、DPI 一缩放，坐标就静默失效，而模型以为自己成功了。所以按顺序试：

1. **`find_elements` / `click_element`** —— UI Automation。按名字通过 `InvokePattern` 点击，鼠标完全不动。要么找到，要么明确告诉你没有。
2. **`ocr`** —— 没有控件树，但有文字。RapidOCR（PaddleOCR 模型跑在 ONNXRuntime 上，约 14MB）读出来，返回**屏幕坐标**的框，识别出来的词可以直接点。

   ![OCR 框](docs/ocr-boxes.png)

   *对 Windows 计算器的真实输出：每个数字都定位到了，还带置信度。同一个区域，系统自带的 Windows OCR 返回 **0 个词**。*

3. **`screenshot` + 坐标** —— canvas / 自绘界面的最后手段。

**控件树实际能覆盖什么**——很容易想当然地认为"浏览器读不到"，于是过早退回像素。实测下来 **Edge/Chromium 是会暴露页面的**：在 4399.com 的一个游戏索引页上，一次 `find_elements` 就返回了 22 个带精确矩形的超链接，包括屏幕外几千像素处的元素，全部可以按名字点击、鼠标一动不动。

**仍然读不到的**：

| | 可读？ |
|---|---|
| 静态 HTML 链接/按钮/输入框 | 能 |
| 原生 Win32 / WPF / UIA 应用 | 能 |
| `canvas` / WebGL / 游戏画面 | 不能 |
| 尚未挂载的虚拟列表 | 不能 |
| 自绘工具栏（不少国产桌面软件） | 不能 |

读不到时依次退回 `ocr`、再退回坐标。

同一件事上的实测（点同一个按钮）：

| 方法 | 耗时 | token | 可靠性 |
|---|---|---|---|
| 截图 + 视觉 + 点击 | 116ms | 2133+ | 中 |
| **UIA 语义定位** | 309ms | ~700 | **高** |
| OCR + 点击 | 459ms | 554 | 中高 |

**另一组实测对比**（同一道 12+3）：

| | 坐标点击 | 语义定位 |
|---|---|---|
| 首次成功率 | 失败（点出 `11`） | **一次成功** |
| 是否移动鼠标 | 是 | 否（InvokePattern） |
| 窗口移动后 | 静默点错 | 仍然正确 |
| 找不到时 | 点空、无反馈 | 明确报错 |

### OCR 双引擎

控件树拿不到（canvas / 游戏 / 网页）、视觉模型又读不准小字时的兜底。两个引擎：

| 引擎 | 原理 | 实测（计算器按钮区） | 耗时 |
|---|---|---|---|
| `windows`（系统自带） | Windows.Media.Ocr | **0 个词** | 566ms |
| `rapidocr`（默认） | PaddleOCR 模型跑在 ONNXRuntime | **14 个词，全部正确** | 2.2s |

系统 OCR 是**按文档文本调优的**——它读得出计算器的小标签（`MC`/`CE`），却读不出大号数字按钮，降采样也没救回来。RapidOCR 直接全读出来，还带置信度：

```
"7"@[125,553,18,26] score=1.0    "8"@[242,554,19,25] score=1.0
"+"@[478,712,20,22] score=0.777  "×"@[478,553,20,21] score=0.585
```

**常驻 worker**：每次新起 Python 进程要重付约 500ms 的模型初始化，所以 `ocr_rapid.py --serve` 以常驻模式运行，server.js 通过管道按行收发：

| | 延迟 | 内存 |
|---|---|---|
| 首次（含启动 + 初始化） | 3.2s | — |
| 后续调用 | **350ms** | — |
| worker 存活时 | — | **96 MB** |
| 空闲 60s 后 | 自动退出 | **释放** |

空闲时长由 `COMPUTER_USE_OCR_IDLE_MS` 控制（默认 60000）。首次运行 uv 会下载 ONNXRuntime 和模型（约 70MB，之后走缓存）。

---

## 工具（26 个）

| 类别 | 工具 |
|---|---|
| 观察 | `screenshot` `zoom` `screen_hash` `wait_for_change` `cursor_position` `list_displays` `list_windows` `active_window` `clipboard_read` |
| **语义定位** | **`find_elements` `click_element` `ui_tree`** |
| **OCR** | **`ocr`**（双引擎，见上） |
| 鼠标 | `mouse_move` `click` `drag` `scroll` |
| 键盘 | `type_text` `key` `hold_key` |
| 窗口/启动 | `activate_window` `launch_app` |
| 编排 | `batch` `wait` |
| 其他 | `clipboard_write` `bench` |

坐标一律是**虚拟桌面的物理像素**。`type_text` 用 `SendInput` 按 Unicode 逐字符注入，中文、引号、emoji 全程原样送出，路径上任何地方都不需要转义。

### 事件驱动，不是连续视觉流

Codex 的 computer use 也不是连续视频流——它同样是"动作 → 截图 → 判断"的循环。本实现提供三件套：

- **`screen_hash`** —— 64×40 感知指纹，44ms，**9 个 token**。调用 → 操作 → 再调用，hash 变了就说明屏幕真变了。
- **`wait_for_change`** —— 阻塞到屏幕真的变化才返回，替代"睡一会儿再截图"。模型不轮询，不浪费回合。
- **`batch`** —— `[click, wait, screenshot]` 一次调用拿到操作后的状态，省掉往返。

---

## 架构

```
MCP client
   │  stdio, JSON-RPC
   ▼
server.js ──── 一行 base64(UTF-8 JSON) 请求 ────▶ host.ps1（常驻进程）
   ▲                                                     │
   └──────── 一行 base64(UTF-8 JSON) 响应 ◀──────────────┘
                                                         │
                                              C# 类 Dsh（启动时编译一次）
                                                         │
                                          StretchBlt / SendInput / UIAutomation
```

| 文件 | 作用 |
|---|---|
| `server.js` | MCP 接线 + 26 个工具定义（策略 / 审批 / 审计都从 `src/` 里调） |
| `src/guard.js` | 四个开关的签名标记（伪造/手改的标记一律忽略并告警） |
| `src/audit.js` | 审计日志：脱敏 + 哈希链 + 轮转 |
| `src/policy.js` | 黑名单 / 白名单 / 速率 / 审批判定 |
| `src/approval.js` | 审批弹窗 + 门锁 |
| `host.ps1` | 常驻 PowerShell 宿主 + C# 帮助类（**必须保持纯 ASCII**，见下） |
| `approval.ps1` | 审批弹窗本体 |
| `ocr.ps1` | Windows 自带 OCR 后端（只能跑在 Windows PowerShell 5.1——.NET Core 没有 WinRT 投影） |
| `ocr_rapid.py` | RapidOCR 后端，一次性或 `--serve`（常驻 worker，空闲自动退出） |
| `policy.json` | 四张策略表、速率限制、审批设置 |
| `guard-panel.ps1` / `.cmd` | 四个防护开关的面板 |
| `toggle-approval.cmd` / `approval-toggle.ps1` | 只切弹窗审批的快速开关 |
| `test-client.js` | 测试客户端（`read` / `uia` / `advanced` / `policy` / `rapid` / `newtools` …） |
| `bench.js` | 逐 op 延迟 + token 成本基准 |

四个关键设计：

1. **常驻宿主 + 一次性编译**
   C# 帮助类在宿主启动时 `Add-Type` 一次。实测：首次约 1.1s（编译），之后**每次调用 3–12ms**。
   对照：每次调用都重新起 PowerShell 的实现是 300–500ms。

2. **StretchBlt 一步完成抓取 + 缩放**
   早期版本先 `CopyFromScreen` 抓全尺寸（2560×1600），再用 `DrawImage` 缩到 1600。
   基准测试显示**缩放本身就要 57ms**，比编码还贵。改成一次 `StretchBlt` 直接抓到目标尺寸后，
   这段开销消失。

3. **默认 JPEG**
   PNG 编码 1600×1000 要 19–33ms，JPEG q88 只要 **4–8ms**，体积也小一半。
   `zoom` 抓小区域时可指定 `format: "png"` 要无损。

4. **base64 传输层**
   stdin/stdout 每行都是 base64，协议线上全是 ASCII，绕开 Windows PowerShell 5.1 的控制台编码问题。

### 运行环境

宿主优先使用 **PowerShell 7**，找不到再回退 Windows PowerShell 5.1：

```
pwsh.exe（PATH）→ %ProgramFiles%\PowerShell\7\pwsh.exe → powershell.exe
```

所有路径都是**运行时探测**的，没有写死任何一台机器的位置。
可用 `COMPUTER_USE_SHELL` 环境变量强制指定。实测两版在截图性能上**没有实质差异**
（capture 60ms vs 66ms，run-to-run 波动更大），选 7 是语言层面的收益。

**注意 `-ReferencedAssemblies` 在两版上行为不同**：

| | 行为 | 需要的引用 |
|---|---|---|
| 5.1 | **追加**到默认引用集 | `System.Drawing, System.Windows.Forms` |
| 7.x | **替换**默认引用集 | 必须列全：`System.Drawing.Common, System.Drawing.Primitives, System.Windows.Forms, System.Private.Windows.Core, System.Private.Windows.GdiPlus, System.Collections, System.Runtime, System.Runtime.InteropServices, System.Diagnostics.Process, System.ComponentModel.Primitives, System.Text.Encoding.Extensions, System.Memory, System.Linq, System.Threading.Thread` |

`host.ps1` 按 `$PSVersionTable.PSEdition` 自动选择。

### 修掉的坑

1. **`scroll` 向下崩溃**（旧包）
   `dwData` 被声明成 `uint` 却传负数。本实现用 `unchecked((uint)(notches * 120))`。

2. **文本输入不转义单引号**（旧包）
   旧包走 `SendKeys` 字符串插值，输入 `it's` 就破坏 PowerShell 语法。
   本实现走 `SendInput` + `KEYEVENTF_UNICODE` 逐字符注入。

3. **PowerShell 5.1 的 `ConvertFrom-Json` 处理不了几百 KB 的字符串**
   它会报 `Invalid object passed in, ':' or '}' expected`，而且**错误消息里会把整个 payload 带出来**。
   所以 `Shot()` 改成返回**换行分隔的裸字段**，由 PowerShell 手工 split，全程不碰 JSON 解析。

---

## 安全模型

**它防什么**

- 模型自己决定去碰密码管理器、银行或支付窗口 → 策略硬拒绝，没有覆盖选项。
- 一次破坏性点击（`关闭` / `Close` / `Delete` / `Send`）或快捷键
  （`alt+f4`、`ctrl+w`、`win+*`、`shift+delete`）→ 审批弹窗。
- **模型回答自己的审批弹窗**——三层互相独立：门锁在弹窗开着时拒绝输入类工具（每个 `await`
  之后都复查），第二个要审批的调用被直接拒绝、不会叠出第二个窗，弹窗本身只认物理事件——注入的
  `SendInput`、post 的 `BM_CLICK` / `WM_SYSKEYDOWN`、UIA 的 `InvokePattern` 全部被丢弃并计数。
- **`batch` 绕过黑名单**——这曾经是一个**真实的漏洞**：`batch` 直接调步骤函数，只问 `needsApproval()`，
  黑名单、白名单和速率限制全都没过，一次调用就能往密码管理器里打字、或者在 `regedit` 里点东西。
  现在每一步都单独过策略、过门锁（目标解析前后各查一次）、单独审计。
- **`launch_app` 把 shell 塞进来**——它启动的程序不是窗口，窗口名单看不见它；`launch_app` 的目标现在
  按可执行文件名单独过 `deny_launch_targets` 和进程黑名单，`cmd` / `powershell` 这类一律拒绝。
- **用一个随手写出来的文件关掉防护**——开关是签名的：伪造、手改**和重放**的标记都会被忽略并记成
  `guard_tamper`，已接受的最大计数器记在 `guard.state.json` 里。
- 失控循环 → `max_actions_per_minute`。
- "它到底干了什么？" → `audit.jsonl` 记下每个动作的目标进程，敏感参数值已脱敏，
  还带 `prev`/`hash` 链和链头 `audit.head.json`：改记录、删尾部、删文件、抹掉 hash 都能被发现
  （`npm run audit:verify`）。
- **被拒绝的动作不再记成功**——挡下来的调用不会写成 `ok: true`，日志里留的是它到底跑没跑和原因；
  "本次会话内记住"按动作本身（元素名 / automationId / 坐标）记，从"前台窗口兜底"来的目标永远不记。

**它不防什么**

- 在**不在名单上**的应用里点错。模型在记事本里点错了东西，没人会拦。
- 同一个用户的文件访问：`policy.json`、`guard.key`、`guard.state.json`、`audit.head.json`、`host.ps1`
  对任何以你的身份运行的东西都够得着——能替换 `guard.key`、把水位和链头连同它们描述的文件一起回滚、
  把名单改宽，或者根本不经过 `server.js`，直接跑 `host.ps1`。
- **它不是沙箱。** 智能体用你的用户权限在你的真实桌面上跑，没有 VM。
  "控制真机"和"完全隔离"架构上互斥——Codex 能隔离，是因为它驱动的是 VM **里面**的桌面，不是你的。
- 提权窗口：UIPI 拦住了向管理员窗口注入输入，UAC 安全桌面进不去。这是 Windows 的边界，不是本功能。

---

## 风险与免责

### 可能出什么事

这不是一个玩具级权限。接上这个服务的智能体可以：

- **以你的身份**发消息、发邮件、付款
- 删除或覆盖它本不该碰的文件
- 读取你屏幕上的任何内容，包括别人的隐私数据
- 改动应用或系统设置

**没有撤销。** Ctrl+Z 覆盖不了"已发送"、"已支付"、"已删除"。

### 提示词注入

智能体会读你的屏幕和屏幕上的文档。**它读到的一切都可能携带指令**：网页、PDF、邮件、
聊天记录、代码注释。一个恶意页面就能让智能体去做你从没要求过的事。

审批闸门能拦住命中危险模式和审批名单的动作，**但拦不住"在两张名单之外的应用里做一次
看起来很正常的点击"**。请把智能体读到的一切都当作不可信输入。

### 你的屏幕会离开这台机器

截图、OCR 结果、剪贴板内容、窗口标题，都会发给你的 MCP 客户端所用的模型供应商。
这本来就是 computer use 的原理——模型必须看到屏幕——但代价是：

- agent 运行期间，**屏幕上可见的一切都会被传出本机**
- 包括别人的聊天记录、文档和个人信息
- 把智能体指向敏感内容前，先确认供应商的数据留存政策
- 能用 `zoom` 截一小块，就别整屏截图

OCR 本身在本地运行、不联网，但它的结果会返回给模型，所以同样会被传出。

### 防护做不到什么

- **它不是沙箱**。智能体以你的身份、在你的桌面、用你的会话和令牌运行。
- 拦不住"两张名单之外的应用里点错了"。
- 拦不住同一个用户身份的文件访问——它可以直接替换 `guard.key`，把 `guard.state.json` /
  `audit.head.json` 连同它们描述的文件一起回滚，改宽 `policy.json`，或者绕开 `server.js`
  直接跑 `host.ps1`。签名、水位和链头提高的是成本、留下的是痕迹，**不是边界**。
- 黑名单、白名单都是子串匹配：**是减速带，不是边界**。
- **审计链是"防篡改的证据"，不是"防篡改"。** `verify` 能对着链头查出被改的记录、被删的尾部、
  被删的文件、被抹掉的 hash；把日志和链头一起重写的人查不出来。

### 责任在你

指向什么目标、保留哪些名单、是否开着审批闸门，都由你决定。
**建议先用着闸门跑一段时间**，看你自己的机器上它到底怎么动，再考虑放开。
不要把 stdio 传输暴露到网络上。

本项目以 MIT 许可证提供，**不附带任何形式的担保**——见 [LICENSE](LICENSE)。
作者不对使用本软件造成的任何损失或损害负责。

---

## 已知限制

- **仅 Windows**。
- **全屏截图约 55ms 是物理下限**（整屏 GPU→CPU 读回）。上 DXGI Desktop Duplication 能再快，但要写 native addon。
- **没有连续视觉流**：只在主动截图的那一刻看到画面（这是设计选择，见上文事件驱动一节）。
- **OCR 约 0.5–2.5 秒**，取决于常驻 worker 是否还活着。
- **`type_text` 依赖焦点**：输入前先 `activate_window` + `click` 定位。
- **弹窗要的是一次物理决策。** 如果键盘上的 `alt+a`、或者点在「允许」上放不了行，说明注入过滤没把你的
  硬件认成物理输入——可以退回 `node src/guard.js set physical off`（或者在面板里取消勾选
  「物理输入校验」），改成普通按钮点击，并请把这个情况报上来。
- **能像你一样写文件的东西仍然赢得彻底。** 它能替换 `guard.key`、把 `guard.state.json` /
  `audit.head.json` 回滚、改 `policy.json`，或者直接跑 `host.ps1`。签名、水位和链头提高门槛、留下痕迹，
  但都不是边界。
- **审计链是"防篡改的证据"，不是"防篡改"。** `verify` 能对着链头查出被改的记录、被删的尾部、
  被删的文件和被抹掉的 hash；把日志和链头一起重写的人查不出来。
- **不是沙箱**：智能体以你的用户权限操作你的真实桌面，没有 VM。
- **提权窗口碰不到**：UIPI 拦截向管理员窗口注入输入，UAC 安全桌面更进不去。

---

## 开发

```bash
npm run verify                # lint + 单测 + 策略 + smoke + 审计链
npm run test:unit             # 单元测试：开关、审计、策略、审批门锁（71 个）
npm run test:smoke            # MCP 握手 + 工具 schema（不需要桌面）
npm run test:inject           # 真弹窗 + 注入 Alt+A / 点击「允许」（需要交互桌面）
npm run test:lock             # 协议层：并行工具调用答不了弹窗（需要交互桌面）
npm test                      # 只读工具，无副作用
npm run test:uia              # 控件树 + 语义搜索
npm run test:policy           # 黑名单/审批名单，29 个样本，误伤即失败
npm run test:typing           # activate_window 聚焦 + 多行/Tab type_text
npm run bench                 # 延迟 + token 成本表
npm run audit:verify          # 走一遍审计链 + 链头，报告被改 / 被删 / 被截断的记录
npm run guard                 # 打印四个防护开关
node src/guard.js set guard off   # 面板背后干的事（写一个签名标记）
node test-client.js policy    # 策略与审计端到端
node test-client.js rapid     # 系统 OCR vs RapidOCR 同区域对比
node test-client.js newtools  # launch_app / 审批闸门 / OCR 驱动点击
```

`src/` 是拆出来、能单独跑测试的安全核心——`guard.js`（签名开关）、`audit.js`（脱敏 + 哈希链 + 轮转）、
`policy.js`（名单、速率、审批判定）、`approval.js`（弹窗 + 门锁）。`server.js` 只剩 MCP 接线和工具定义。

`test/` 是 CI 跑的无头测试集（`npm run test:unit` 现在 71 个用例，加上 `npm run test:smoke`）；
`e2e/` 放着两个要驱动真实桌面的脚本：`npm run test:inject` 和 `npm run test:lock`。
CI 在 Windows 上跑 Node 20 / 22 / 24 的完整链路，另外留了一条 Node 18 的"只跑运行时"通道
（ESLint 10 不支持 18，所以那条通道不跑 lint 和格式检查）。

`docs/make-*.ps1` 可以从**当前屏幕**重新生成 README 里的图，所以截图不是手绘的，随时可复现。

`host.ps1` 和 `ocr.ps1` **必须保持纯 ASCII**：Windows PowerShell 5.1 读取**无 BOM 的 .ps1 会按 ANSI 解码**，
一个非 ASCII 字节就可能吞掉换行，把嵌入的 C# 弄坏。校验：

```powershell
((Get-Content .\host.ps1 -AsByteStream) | Where-Object { $_ -gt 127 }).Count   # 必须是 0
```

`approval.ps1`、`approval-toggle.ps1` 和 `guard-panel.ps1` 是例外：它们要给用户显示中文，
所以**带 UTF-8 BOM** 保存，两种 shell 都能正确读取。

## 贡献

Issues 和 PR 都欢迎。三条规矩让这个仓库保持可读：

1. **不引入第三方自动化代码。** 全部意义就在于碰到你机器的那几行代码可以一口气读完。
   `host.ps1` 只有 C# + Win32，没有别的。
2. **测量，不要声称。** 为了速度改东西，就在 PR 里放一个数字——`npm run bench` 就是干这个的。
3. **安全修复必须带一个"没有这个修复就会失败"的测试。** `npm run test:inject`、`npm run test:lock`
   和 `test/*.test.mjs` 就是例子；`npm run verify` 必须保持绿色。

和安全相关的行为都写在 [SECURITY.md](SECURITY.md) 里——改动任何一个防护层的行为，
必须在同一个 PR 里改那份文档。

## 许可证

MIT——见 [LICENSE](LICENSE)。
