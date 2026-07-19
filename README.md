# SessionMap

> 当人同时驱动多个 AI Agent，真正稀缺的已经不是算力，而是人的注意力连续性。

终端和 session 记录了发生过什么，却没有保存：为什么走到这里、试过什么、否定了什么、做了什么决定、现在卡在哪里。

SessionMap 把 Claude Code、Codex 等 coding agent 散落的对话持续整理成一棵以工作主线为核心的外置思维树。Session 可以结束，思路不会丢；死路也不会被遗忘。它最终只解决一个问题：**让人切回任何一条工作线时，3 秒找回当时的自己。**

SessionMap 不是 session 看板。一级对象是一件正在推进的工作，不是终端、进程或对话。Session 只是只读数据源和落在树上的光标：旧 session 结束后树仍然存在，新 session 可以继续生长同一条主线。

完整产品理念、交互裁决顺序与视觉标准见 [产品与设计宪章](docs/product-design.md)。实现边界见 [架构说明](docs/architecture.md)。

## 核心差异

- **展示思考结构，而不是活动卡片。** goal、task、attempt、finding、blocker、decision、note 与死路会作为结构永久保留。
- **用模型判断语义归属。** session 是否继续已有主线、哪里发生转折、用户正在被要求做什么，都由 roll 模型判断；cwd、关键词和正则不能替代这些判断。
- **对象恒存。** 工作线和 session 入口只会衰减或归档，不会静默消失。终端关闭后，同一入口会变成 resume 动作。
- **有界且崩溃安全。** 树和 transcript offset 同住一个原子替换的 JSON 文件；roll 按 at-most-once 提交，模型输入不随 transcript 总长度增长。
- **本地优先。** 无 CDN、无遥测、无 transcript 回写。服务只监听 `127.0.0.1`，所有 `/api/*` 都需要本机 capability token。

## 安装与体验

SessionMap 是本机 Bun 后台提供的本地网页。系统浏览器是唯一正式界面；没有原生 App、
菜单栏、WKWebView 或云端账户。

从源码启动：

```bash
git clone https://github.com/hao-cyber/sessionmap.git
cd sessionmap
bun install --frozen-lockfile
bun run start
# bun run start 会用一次性 ticket 打开本地授权页面
```

安装常驻后台并打开页面：

```bash
bun run build
./dist/sessionmap install
./dist/sessionmap open
```

直接输入 `http://127.0.0.1:4317` 不会获得动作权限，这是刻意的安全边界。
`sessionmap open` 会等到页面完成首次渲染才报告成功；系统仅接收 URL、但浏览器没有
产生可见页面时，命令会明确失败。可用 `--browser chrome`、`--browser firefox` 或
`--browser "Google Chrome"` 等选择任意已安装的 macOS 浏览器。
Web bundle 使用内容版本隔离缓存；已有旧 Maintrail/SessionMap 缓存的浏览器 profile
也会请求新资产，不需要用户手动清理缓存。

生成一份不会读取真实 transcript 的演示树：

```bash
bun src/cli.ts demo --state-dir /tmp/sessionmap-demo
bun src/cli.ts serve --state-dir /tmp/sessionmap-demo --no-watch
```

## 数据来源

SessionMap 只读扫描以下 append-only JSONL：

```text
~/.claude/projects/*/<sessionId>.jsonl
~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl
~/Library/Application Support/orca/codex-runtime-home/home/sessions/...
```

标准目录、环境变量目录和 Orca 管理的 Codex home 会按 provider + session id 去重。同一个 WAL 即使被镜像到多个路径，也不会重复执行非幂等的 `grow`。

默认 roll 引擎是 `claude -p`。已安装且已登录的 `codex`、`kimi`、`grok` 会出现在页面下拉框中；只安装但未登录的 CLI 会被明确标记，而不是选中后才静默失败。

## 使用方式

- 点击主线标题：切回该工作主线最合适的 session。
- 单击 session 行展开或折叠脉络；双击或点击行尾“切回/恢复”进入对应终端。
- `⌥` + 点击 session：通过 Orca 向该 session 发话。
- 右键主线：立即归档；toast 中可以撤销。归档不是删除，后续 roll 仍会继续积累。
- 双击画布空白或点击 **Fit**：恢复全景。
- 点击结构行或 session 的“脉络”控件展开详情；选择会跨刷新保留。平移、缩放、Fit
  和窗口变化只调整视窗，不会替用户自动展开或折叠内容。

有 Orca 时，SessionMap 会用最后一条用户消息匹配 `orca worktree ps`，再定位 pane 与 terminal handle，完成切换、复活或发话。没有 Orca 时，macOS 会按 TTY 精确聚焦 iTerm2 / Terminal，并在需要时打开新 Terminal 执行 resume；无 Orca 时不会注入键盘输入。

## 命令行

```bash
sessionmap serve                 # watcher、串行 roll worker、本地 UI
sessionmap open                  # 安全地打开已运行服务的浏览器入口
sessionmap once                  # 消费一轮待处理 transcript 增量
sessionmap install               # 安装并启动当前用户的 launchd 服务
sessionmap uninstall             # 移除 launchd 服务
sessionmap status                # 查看持久状态摘要
sessionmap demo                  # 写入演示状态
```

按命令可使用 `--state-dir PATH`、`--port PORT`、`--no-open`、`--no-watch`；`open` 和
`serve` 还支持 `--browser APP`，常用别名包括 chrome、safari、firefox、edge、brave、
arc。正式状态默认位于：

```text
~/Library/Application Support/SessionMap/state.json
~/Library/Application Support/SessionMap/capability.token
```

token 权限固定为 `0600`。从旧版 Maintrail 升级时，首次安装会原子迁移 `~/.maintrail` 中的状态和 token；旧状态保留作回滚依据，新服务验证健康后才移除旧 launchd 入口。

## 有界数据管线

```text
Claude / Codex append-only JSONL
        │  5 秒轮询 · 32 KiB / 90 秒 linger · 45 秒冷却
        ▼
结构信号 adapter
        │  用户/assistant 文本 + 工具与错误元数据 · ≤ 12 KiB
        ▼
一次性语义 roll 模型
        │  已有主线 + 当前子树 ≤ 120 行 · ≤ 6 个 op
        ▼
单写者 runtime
        │  子树授权 · offset-before-apply · 原子 rename
        ▼
state.json ───────────────► 本地 SessionMap UI
```

模型只拥有开放语义判断：主线归属、结构性转折、ask 的含义。Runtime 拥有 ID、schema、子树写边界、offset、串行化、幂等策略与所有副作用。模型输出始终按不可信输入处理。

## 开发、构建与发布

```bash
bun run dev               # 开发服务
bun run check             # 类型、前端语法、回归测试与 CLI 构建
bun run build             # 单文件 sessionmap CLI
```

`bun run build` 使用 Bun 生成当前平台的 standalone CLI。发布链不生成 macOS App、
Homebrew Cask、Developer ID 签名或 Apple 公证产物。

回归测试覆盖损坏状态修复、跨主线越权、reattach 只读边界、巨行与半行 JSONL、自噬排除、12 KiB 硬上限、at-most-once 崩溃窗口、命令转义、Markdown / HTML 注入、capability 鉴权、open ticket/ready 回执与 Origin / media type 校验。

贡献前请阅读 [贡献指南](CONTRIBUTING.md)。安全问题请按 [安全策略](SECURITY.md) 私下报告。

MIT © 2026 Hao
