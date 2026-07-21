# ADR 0013：用私有 workspace 组织模块化单体

- 状态：accepted
- 日期：2026-07-21
- 替代：[ADR 0012](0012-keep-single-package-modular-monolith.md)

## 背景

SessionMap 的源码同时包含 Bun runtime、浏览器资产、macOS Swift 壳和可与服务组装分离的
核心状态/采集逻辑。此前判断这些边界不值得引入 workspace；维护者随后明确要求用
`apps/` 与 `packages/` 统一仓库导航，同时要求所有运行、状态、安全和发布契约保持不变。

## 约束

- 一个 Bun 服务、一个持久状态文件、一个单写者、一个正式地图文档。
- Web 只能作为 vendored 资产由 Bun runtime 提供；desktop 只是无状态展示壳。
- 只有一个产品版本、一条 release workflow、一个 standalone CLI 和现有安装渠道。
- 不增加 Electron、CDN、遥测、第二 runtime、独立部署或兼容桥。

## 备选方案

1. 保持根级单 package，只做内部目录拆分。
2. 建立私有 workspace，以包边界表达源码所有权，但保持模块化单体的运行和发布。
3. 把 Web、desktop 与 core 做成独立版本、构建和发布的多产品 monorepo。

## 决定

选择方案 2。建立 `apps/runtime`、`apps/web`、`apps/desktop` 与 `packages/core`。runtime 是
唯一可执行应用并依赖 core；Web 只是它的构建时资产输入；desktop 只通过回环 URL 加载
runtime 提供的文档。workspace package 全部为 private，版本仍只取根 `package.json`。

根级 `scripts/`、`tests/` 和 workflows 保持统一编排，不为目录对称增加更多 package、
独立 bundler 或发布步骤。`@sessionmap/*` 子路径只用于显式表达包间依赖；包内仍使用相对
导入。

## 后果

- 好处：core 与运行时副作用分离，Web 和 Swift 壳的资源归属清楚，构建中的跨边界路径
  可直接搜索和测试，后续修改不再依赖含混的根级 `src/`/`web/`。
- 代价：需要维护 workspace 配置、TypeScript paths 和 package manifests；文件移动会使
  Git 历史查看多一步。由于没有独立版本和构建图，复杂度被限制在源码解析层。
- 不变：状态写入者、失败与重启语义、API/CSP/capability、资源 URL、App 权限、签名、
  公证、安装和 release artifact 均不变。

## 迁移与回滚

移动文件后同步 root scripts、Bun/TypeScript 解析、测试、文档、CI 和 release 资源归档。
不读取或重写用户状态。若回滚，恢复原目录和相应路径配置即可；新旧 binary 读取相同状态，
无需数据兼容层。

## 验证

`bun run check` 覆盖类型、Web 资产、隐私门禁、Swift 壳、发布描述、完整测试、standalone
CLI 和 App 构建。另以隔离状态启动编译后的服务，检查 `/health` 和真实页面截图；release
workflow 继续在原生架构 runner 上执行安装、launchd 重启、签名和公证冒烟。
