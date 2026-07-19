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

SessionMap 以原生 macOS 应用为首要入口。应用内嵌 Bun 编译的完整后台服务，不要求用户另装 Bun；菜单栏可查看当前最需要注意的工作线，主窗口使用 WKWebView 承载同一份本地思维图。

正式发布后推荐通过 Homebrew Tap 安装：

```bash
brew install --cask hao-cyber/tap/sessionmap
open -a SessionMap
```

项目进入 Homebrew 官方 Cask 后可简化为：

```bash
brew install --cask sessionmap
```

从源码体验：

```bash
git clone https://github.com/hao-cyber/sessionmap.git
cd sessionmap
bun install --frozen-lockfile
bun run build:app
open dist/SessionMap.app
```

只运行本地网页入口：

```bash
bun run start
# bun run start 会自动打开带本地 capability 的页面
# 后台服务已运行时也可执行：sessionmap open
```

直接输入 `http://127.0.0.1:4317` 不会获得动作权限，这是刻意的安全边界。

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

默认 roll 引擎是 `claude -p`。已安装且已登录的 `codex`、`kimi`、`grok` 会出现在应用下拉框中；只安装但未登录的 CLI 会被明确标记，而不是选中后才静默失败。

## 使用方式

- 点击主线标题或带光标的 session 行：切回仍在运行的终端；终端已关则 resume。
- `⌥` + 点击 session：通过 Orca 向该 session 发话。
- 右键主线：立即归档；toast 中可以撤销。归档不是删除，后续 roll 仍会继续积累。
- 双击画布空白或点击 **Fit**：恢复全景。
- 缩小时只看主线；放大并停稳后，视窗内节点逐层展开。手动折叠始终优先且跨刷新保留。

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

按命令可使用 `--state-dir PATH`、`--port PORT`、`--no-open`、`--no-watch`。正式状态默认位于：

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
bun run check             # 类型、前端语法、回归测试、CLI 与原生构建
bun run build             # 单文件 sessionmap CLI
bun run build:app         # 当前架构的 SessionMap.app
bun run release:mac       # arm64 / x64 签名发布包与 Homebrew Cask
```

`release:mac` 会自动查找 **Developer ID Application** 证书，对内嵌 Bun 后台使用最小 JIT entitlement，对应用启用 Hardened Runtime，并输出两种架构的 app zip、`SHA256SUMS` 和可提交到 Homebrew Tap 的 `sessionmap.rb`。

公证是明确的网络操作，只有设置开关才会上传到 Apple：

```bash
SESSIONMAP_NOTARIZE=1 \
SESSIONMAP_NOTARY_PROFILE=sessionmap-notary \
bun run release:mac
```

公证通过后脚本会 staple ticket、执行 Gatekeeper 评估，再生成最终 zip。Bun 当前按架构发布 standalone executable，因此 arm64 与 x64 分开构建，不伪装成 universal binary。

回归测试覆盖损坏状态修复、跨主线越权、reattach 只读边界、巨行与半行 JSONL、自噬排除、12 KiB 硬上限、at-most-once 崩溃窗口、命令转义、Markdown / HTML 注入、capability 鉴权与 Origin / media type 校验。

贡献前请阅读 [贡献指南](CONTRIBUTING.md)。安全问题请按 [安全策略](SECURITY.md) 私下报告。

MIT © 2026 Hao
