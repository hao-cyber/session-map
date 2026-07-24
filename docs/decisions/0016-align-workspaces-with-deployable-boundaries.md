# ADR 0016：按可执行入口与构建输入对齐 workspace

- 状态：accepted
- 日期：2026-07-22
- 修订：[ADR 0013](0013-private-workspace-modular-monolith.md) 的目录命名

## 背景

ADR 0013 将 Bun runtime 和静态 Web 资产都放在 `apps/` 下。实际发布边界只有 CLI 与 macOS
desktop 是可执行入口；Web 没有独立进程、部署、状态或生命周期，只是由 CLI 构建时嵌入并
通过同一回环服务提供的资产输入。`runtime` 目录名也隐藏了用户和维护者真正可以直接运行的
入口是 CLI。

## 约束

- 保持一个 Bun 服务、一个持久状态文件、一个单写者和一个正式地图文档。
- 不改变 CLI 命令、binary 名称、状态 schema、端口、API、capability、launchd 或发布产物。
- Web 继续完全 vendored，不增加独立 dev server、CDN、遥测或远程字体。
- 不为目录对称预建没有独立职责的 `host`、`harness` 或其他 package。

## 备选方案

1. 保留 `apps/runtime` 与 `apps/web`，仅在文档中解释其含义。
2. 只把 `apps/runtime` 改名为 `apps/cli`，继续把非部署的 Web 资产称为 app。
3. 把可执行入口放在 `apps/`，把被入口消费的 Web 资产放在 `packages/`。
4. 同时拆出 host、harness 等新层，使目录外观更对称。

## 决定

选择方案 3：`apps/runtime` 改为 `apps/cli`，package 名改为 `@sessionmap/cli`；`apps/web`
移动到 `packages/web`，package 名仍为 `@sessionmap/web`。CLI 继续依赖 core 与 Web，desktop
继续只通过回环 HTTP 加载 CLI runtime 提供的同一文档。

方案 4 被拒绝，因为当前没有可独立变化、测试或部署的 host/harness 职责；预建层级会增加
概念和依赖边，而不会加强现有契约。

## 后果

- `apps/` 可直接回答“哪些东西可以运行”，`packages/` 表达可复用或构建时输入。
- 源码依赖保持 `apps/cli → packages/core + packages/web`，Web 和 core 不反向依赖 app。
- 开发热读资源根、构建脚本、release workflow、TypeScript paths、测试和文档需要同步改路径。
- Git 历史查看目录时仍可能需要 follow rename；不产生运行时兼容层。

## 迁移、失败与回滚

迁移只移动仓库源码并更新静态路径，不读取或改写用户状态。开发模式若路径遗漏会退回嵌入资产，
因此验证必须同时覆盖源码热读和 standalone 嵌入；release 路径遗漏会由构建及许可证归档检查发现。
回滚时恢复目录、package 名和解析路径即可，已安装 binary、launchd 配置和持久状态无需转换。

## 验证

- workspace fitness test 固定新目录、package 名和依赖方向，并确认旧入口不存在。
- `bun run check` 覆盖类型、Web 资产、隐私、安全、完整测试、CLI 与 App 构建。
- standalone CLI 验证版本与帮助；隔离状态启动服务并检查健康、快照与 vendored 页面资产。
