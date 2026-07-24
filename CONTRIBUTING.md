# 贡献指南

SessionMap 的第一条不变量是：它是一棵外置思维树，不是 session 看板。模型负责开放语义判断，runtime 负责所有封闭边界与副作用。任何削弱这条分工的改动，都必须先在设计讨论中说明为什么仍能满足“三秒找回当时的自己”。

## 开始之前

请先阅读：

1. [产品与设计宪章](docs/product-design.md)：产品本体、裁决顺序、交互与视觉标准。
2. [架构说明](docs/architecture.md)：数据管线、提交语义、写边界与安全模型。
3. 根目录 [AGENTS.md](AGENTS.md)：供 coding agent 与贡献者共同遵守的工程约束。

## 本地检查

```bash
bun install --frozen-lockfile
bun run check
# 可选：下载经 SHA-256 校验的固定版本 Gitleaks，扫描全部 Git 历史
bun run check:secrets
```

涉及 UI 的改动必须针对真实渲染结果验收，不能只检查源码：

```bash
bun apps/cli/src/cli.ts demo --state-dir /tmp/sessionmap-demo
SESSIONMAP_DEV=1 bun apps/cli/src/cli.ts serve \
  --state-dir /tmp/sessionmap-demo \
  --no-watch \
  --no-open
# 另一个终端：
bun apps/cli/src/cli.ts open --state-dir /tmp/sessionmap-demo
```

至少检查首次打开、Fit、缩放 LOD、手动折叠、归档/撤销与窄浏览器窗口。截图应确认层级、间距、裁切、重叠和状态色语义。

## 不接受的方向

- CDN 资源、遥测、分析 SDK 或 transcript 回写。
- 用 cwd、关键词、正则代替模型做主线归属、转折或 ask 语义判断。
- 删除 resolved / dead 节点，或按活跃度让 session 入口消失。
- 为兼容未被证明仍有人使用的旧行为，而破坏正确的数据模型。
- 把 `node_modules`、构建产物、完整 QA 截图集、本地 UI baseline 图像或真实 transcript 提交到 Git。

经过筛选、用于 README 的轻量产品截图可以提交；其中不能包含真实用户名、路径、token 或 transcript 隐私。本地 `.sessionmap-ui-baseline.png`、`*.baseline.png` 与 `artifacts/` / `screenshots/` 捕获一律不进仓库。

## 提交原则

- 一个提交只表达一个可解释的逻辑变化。
- 显式暂存相关路径，不使用宽泛的 `git add .` 或 `git add -A`。
- 改动持久化格式时必须提供恢复、防损坏与迁移测试。
- 改动动作层时必须证明副作用仍只由 loopback 上的显式用户点击触发。
- 改动视觉编码时，状态语义优先于装饰；红色只保留给需要拍板或错误级行动信号。

## 发布节奏

合入 `main` 不等于立即发布。仓库每天 Asia/Shanghai 22:00 检查一次：精确 HEAD 已通过
CI、完整发布门禁再次通过，且相对最近 Release 有新源提交时，自动递增 beta 并触发签名、
公证和双架构发布；没有变化则跳过。Release 成功后由同一 workflow 用其校验清单更新
Homebrew tap。维护者需要立即发布时，应手动触发 `Daily release candidate`，不得手工移动
已有 tag 或绕过 Release workflow 上传 binary。
