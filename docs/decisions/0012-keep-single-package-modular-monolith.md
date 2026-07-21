# ADR 0012：保持单 package 的模块化单体

- 状态：superseded by [ADR 0013](0013-private-workspace-modular-monolith.md)
- 日期：2026-07-21

## 背景

仓库同时包含 Bun runtime、浏览器资产和 macOS WKWebView 壳，表面上可以套用
`apps/web`、`apps/desktop`、`packages/core` 的标准 monorepo 结构。需要判断这些目录是否
对应真实的独立部署、版本、状态或复用边界，并整理已经过大的 Web 源文件。

## 替代关系

本决策保留当时对运行与发布边界的判断；后续用户明确要求用 `apps/` 与 `packages/`
表达源码所有权。ADR 0013 在不改变单 runtime、单状态与单 release 的前提下替代了
“不采用 workspace”这一目录决策。

## 约束

- 一个 Bun 服务、一个持久状态文件、一个单写者和一个正式地图文档。
- Web 资产必须 vendored 并嵌入 standalone CLI。
- macOS App 只展示同一文档，不拥有业务状态、API 或第二个服务生命周期。
- CLI、App、installer 与 Homebrew 渠道共享一个版本和 release workflow。
- 结构调整不得改变产品行为、UI、状态 schema、API、安全边界或安装方式。

## 备选方案

1. 建立 Bun workspace：`apps/web`、`apps/desktop`、`packages/core`。
2. 保持单 package，把现有源码按真实职责做内部模块化。
3. 保持所有文件不动，只补充文档。

## 决定

选择方案 2。Web 是 Bun runtime 的嵌入式读取层，不是可独立部署的 app；desktop 是独立
编译的分发容器，但不是独立运行的产品；core 也没有第二个独立消费者或版本。workspace
会增加包解析、构建顺序、版本和发布协调，却不能带来独立发布、复用或团队自治收益。

保留根级 `package.json`、`src/cli.ts` 编译入口和既有 workflow。只把过大的 Web JS/CSS
按职责切片，由 `src/assets.ts` 显式、确定性地重组为原有 `/assets/app.js` 与
`/assets/styles.css`。TypeScript 模块在出现真实契约分离前继续平铺，避免用目录伪造边界。

## 后果

- 好处：发布、测试和安装仍围绕一个版本与 binary；浏览器缓存、CSP 和资源 URL 不变；
  Web 热点文件更易导航。
- 代价：Web 切片仍共享一个私有 IIFE 作用域，只是源码组织边界，不宣称为可独立复用模块；
  组合顺序由资产清单负责并必须通过完整 bundle 解析测试。
- 触发复审的条件：出现第二个独立部署 runtime；同一 core 被两个真实应用独立消费；或
  Web/desktop 获得独立版本、发布节奏和团队所有权。

## 验证与回滚

`bun run check` 验证组合后的浏览器脚本、完整资产版本、API/状态契约、standalone CLI 和
macOS App。拆分前后资源内容做逐字节比较。回滚只需按清单顺序连接切片并恢复两个单文件，
不需要状态迁移，也不改变 launchd 或安装事务。
