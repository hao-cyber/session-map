<h1 align="center">SessionMap</h1>

<p align="center"><strong>The thinking map for coding agents.</strong><br />See the work behind your local agent sessions, then pick up any thread without reconstructing it from terminal history.</p>

<p align="center">
  <a href="https://github.com/hao-cyber/session-map/releases"><img alt="GitHub Release downloads" src="https://img.shields.io/github/downloads/hao-cyber/session-map/total?label=release%20downloads&amp;color=6f55c7" /></a>
  <a href="https://formulae.brew.sh/analytics/install-on-request/30d/"><img alt="Homebrew install requests in the last 30 days" src="https://img.shields.io/badge/dynamic/regex?url=https%3A%2F%2Fformulae.brew.sh%2Fapi%2Fanalytics%2Finstall-on-request%2F30d.json&amp;search=%5C%22formula%5C%22%3A%5C%22hao-cyber%2Ftap%2Fsessionmap%5C%22%2C%5C%22count%5C%22%3A%5C%22%28%5B%5E%5C%22%5D%2B%29%5C%22&amp;replace=%241&amp;label=brew+requests+%2830d%29&amp;color=9A5B00&amp;cacheSeconds=86400" /></a>
</p>

<p align="center"><a href="#english">English</a> · <a href="#中文">中文</a> · <a href="#快速安装">安装</a> · <a href="docs/product-design.md">产品宪章</a></p>

---

## English

Open enough coding-agent sessions and the terminals stop telling the whole story.
SessionMap organizes local Claude Code, Codex, Kimi, Grok, and MiniMax sessions by
the work they belong to. It keeps the decisions, failed attempts, and exact place
to resume after a session ends.

### What stays with you

- **The work, not a session dashboard.** Each theme holds one continuing line of
  thought. Sessions are durable entry points within it.
- **Decisions keep their history.** New evidence can replace an old judgment, but
  the earlier path—and why it changed—stays visible.
- **A way back that does not guess.** SessionMap focuses a live terminal when it
  can verify one. Otherwise it resumes the original provider, session ID, and cwd.
- **Everything stays local.** One Bun service listens on `127.0.0.1`. There is no
  SessionMap account, analytics, telemetry, CDN, or transcript write-back.

### Install on macOS

SessionMap supports macOS 13 or later on Apple Silicon and Intel Macs.

**Recommended:** download the latest signed and notarized
[`SessionMap-<version>.pkg`](https://github.com/hao-cyber/session-map/releases).
Open it with Installer; it installs the service and launches the app. No terminal,
Homebrew, or Bun is required.

**Homebrew:** two commands are required here. The first installs the CLI; the
second installs and starts your background service.

```bash
brew install hao-cyber/tap/sessionmap
sessionmap install
sessionmap open
```

In Homebrew, a `tap` is simply a third-party formula repository. The full install
command above adds `hao-cyber/tap` automatically, so there is no separate
`brew tap` step.

After upgrading the CLI, run `sessionmap install` once more to switch the service
to the new binary:

```bash
brew upgrade sessionmap
sessionmap install
```

New beta builds are cut by GitHub Actions once per day when `main` contains new,
fully tested code. A release is published only after the complete native build,
install, signing, and notarization gates pass; the Homebrew tap is updated from
that Release afterward. No source change means no empty daily release.

Open the app or visit [http://127.0.0.1:4317/](http://127.0.0.1:4317/) in a local
browser. The first launch lets you import 7, 30, or 90 days of history, start from
a custom date, or skip old sessions. New sessions are organized in the background
whichever option you choose.

### Essential commands

| Command | Purpose |
|---|---|
| `sessionmap open` | Open the map and verify its first rendered frame |
| `sessionmap now` | List work needing attention; use `--jump N` to return |
| `sessionmap status` | Inspect persistent-state status |
| `sessionmap install` | Install, update, or repair the launchd service |
| `sessionmap once` | Process one round of transcript updates |
| `sessionmap uninstall` | Remove the launchd service |

See the [product charter](docs/product-design.md),
[architecture](docs/architecture.md), [contributing guide](CONTRIBUTING.md), and
[security policy](SECURITY.md) for the full contracts.

---

## 中文

Coding agent 开得越多，终端列表就越难回答几个简单的问题：这件事为什么走到这里？哪些
办法已经试过？最后做了什么决定？下一步从哪儿接着做？

SessionMap 把 Claude Code、Codex 等 coding agent 的本地对话，按它们背后的工作主线整理成
一张思维地图。Session 关了，走过的路径还在，包括那些后来被否定的尝试。目标很具体：
**切回任何一条工作线时，3 秒内找到上次停下的位置。**

### 留下来的不只是摘要

- **先看工作，再看 session。** 一级对象是一件持续推进的工作；session 是其中的入口，也是
  你上次读到哪里的光标。
- **旧判断不会被悄悄抹掉。** 目标、尝试、发现、决策、卡点和死路都保留。新证据可以修订
  旧判断，但改过什么、为什么改，仍然看得见。
- **现在做到哪儿，一眼能找到。** 每个 session 都有整体主标题、最新进展、实时终端状态和
  返回入口。
- **切回去之前先验证。** 终端还在，就回到原终端；终端关了，再用原 provider、session ID、
  cwd 和原生 resume 命令恢复。证据对不上时会停下来，不会随便猜一个 session。

## 快速安装

支持 macOS 13 及以上的 Apple Silicon 与 Intel Mac。

### 安装包（推荐）

从 [GitHub Releases](https://github.com/hao-cyber/session-map/releases) 下载最新的
`SessionMap-<版本>.pkg`，双击安装后会自动启动服务并打开 SessionMap App。安装包与 App
使用 Developer ID 签名并通过 Apple 公证，不需要终端、Homebrew 或 Bun。

### Homebrew

这里确实需要两条命令。`brew install` 安装 `sessionmap` CLI；`sessionmap install` 把后台
服务安装到当前用户并启动它。

```bash
brew install hao-cyber/tap/sessionmap
sessionmap install
sessionmap open
```

`tap` 就是 Homebrew 的第三方软件配方仓库。上面的完整命令会自动添加 `hao-cyber/tap`，
不用提前执行 `brew tap`。

以后升级 CLI，记得再跑一次 `sessionmap install`，让后台服务切换到新版本。已有地图和历史
不会被删除：

```bash
brew upgrade sessionmap
sessionmap install
```

当 `main` 出现已经通过完整 CI 的新代码时，GitHub Actions 每天集中切割一次新 beta；只有
双架构构建、安装冒烟、签名和 Apple 公证全部成功后才创建 Release，随后自动同步 Homebrew
tap。当天没有新代码就不会生成空版本。

安装后可以打开 App，也可以在本机浏览器访问
[http://127.0.0.1:4317/](http://127.0.0.1:4317/)。`sessionmap open` 会帮你打开浏览器，
同时确认页面首帧已经正常显示。

首次打开时，SessionMap 只统计有多少 session 可以恢复，不读取旧正文，也不会调用模型。
接着你可以导入最近 7、30、90 天或某个日期之后的历史，也可以直接跳过。无论怎么选，新对话
都会在后台持续整理。历史导入可以暂停、继续、取消，以后也能补扫更早的内容。

## 工作方式

```text
Claude / Codex / Kimi / Grok transcripts · MiniMax snapshots
              │ 只读发现与有界增量
              ▼
        已登录的 Roll 模型
              │ 主线归属、结构转折、当前 ask
              ▼
        单写者 SessionMap runtime
              │ offset-before-apply · 原子状态替换
              ▼
        state.json ─────► 本地地图文档
```

- Provider registry 发现完整、可恢复的 transcript/event log；memory、摘要和 prompt history
  不能独立驱动思维树。
- 每轮最多把 12 KiB 有界语义增量交给用户选择且已登录的 Claude、Codex、Kimi 或 Grok CLI。
- 模型判断开放语义；runtime 只负责 ID、schema、授权边界、串行写入、offset 和副作用。
- 浏览器、CLI、installed Web App 和 macOS 极薄壳读取同一个 Bun 服务和同一份状态。

## 数据、安全与隐私

- Transcript 永远只读；SessionMap 不修改 agent 的原始记录。
- 服务只绑定 `127.0.0.1`，Web 资产全部 vendored，不使用 CDN、远程字体或遥测。
- 状态只保存在 Git worktree 之外：

  ```text
  ~/Library/Application Support/SessionMap/state.json
  ~/Library/Application Support/SessionMap/capability.token
  ```

- `capability.token` 权限固定为 `0600`，只用于 `sessionmap open` 的短期首帧回执。
- 显式删除只删除 SessionMap 记录并永久排除再次加工，不会删除原始 transcript。
- 模型服务如何处理被提交的有界增量，取决于用户与对应服务的账户及数据条款。

## 使用

- 点击工作主线标题：展开或折叠该主题的 Sessions 目录。
- 点击主题行的“脉络”：原位展开该主题唯一的因果结构树。
- 点击“回到终端”或“恢复终端”：返回经验证的原 session；双击 session 行执行同一动作。
- `Option` + 点击 session：Orca 可用时向该 session 发话。
- 右键主线：归档；可通过 toast 撤销。归档不会删除对象。
- Session 行尾删除：删除本地记录并阻止再次加工，原始 transcript 保持不变。

## 命令行

| 命令 | 作用 |
|---|---|
| `sessionmap open` | 打开地图并确认首帧成功渲染 |
| `sessionmap now` | 一屏查看待处理工作；`--jump N` 可直接切回 |
| `sessionmap status` | 查看持久状态摘要 |
| `sessionmap install` | 安装、更新或修复当前用户的 launchd 服务 |
| `sessionmap once` | 消费一轮待处理 transcript 增量 |
| `sessionmap uninstall` | 移除 launchd 服务 |
| `sessionmap demo` | 创建不读取真实 transcript 的合成演示状态 |

常用参数包括 `--state-dir PATH`、`--port PORT`、`--no-open`、`--no-watch` 和
`--browser APP`；浏览器别名支持 chrome、safari、firefox、edge、brave 与 arc。

## 开发

需要 Bun 1.3.13 或更高版本：

```bash
git clone https://github.com/hao-cyber/session-map.git
cd session-map
bun install --frozen-lockfile
bun run start
```

```bash
bun run dev        # 开发服务
bun run check      # 类型、Web、隐私、测试、CLI 与 App 构建门禁
bun run build      # standalone CLI
bun run build:app  # macOS 极薄壳
```

进一步阅读：

- [产品与设计宪章](docs/product-design.md)
- [仓库结构](docs/repository-structure.md)
- [系统架构](docs/architecture.md)
- [模块文档索引](AGENTS.md#模块文档索引)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)

MIT © 2026 Hao
