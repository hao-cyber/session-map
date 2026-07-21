# 仓库结构

SessionMap 使用**私有 Bun workspace 组织的模块化单体**。`apps/` 与 `packages/` 表达源码
所有权和允许的依赖方向，不代表出现了多个业务 runtime、状态源或发布版本。

```text
apps/
  runtime/
    src/            唯一 Bun CLI、服务组装、HTTP、launchd、迁移与资产嵌入
  web/
    src/
      app/          按职责切分、最终合成为 /assets/app.js 的浏览器源码
      styles/       按职责切分、最终合成为 /assets/styles.css 的样式源码
      vendor/       随 standalone binary 嵌入的第三方运行时、许可证与图标
      index.html    唯一正式地图文档的 HTML 外壳
  desktop/
    src/            只加载同一回环地图文档的 AppKit/WKWebView 极薄壳
packages/
  core/
    src/            状态、树、采集、模型滚动、session 导航证据与读取投影
scripts/            根级检查、构建、App/installer 组装与安装脚本
tests/              跨模块契约、Web、runtime 与发布边界测试
docs/               产品宪章、架构、模块说明和 ADR
.github/workflows/  对同一产品版本执行 CI 与 Release
```

## 真实边界

- `@sessionmap/core` 是无 HTTP、launchd 和桌面容器职责的领域与采集 package。它由唯一
  runtime 消费；拆出它是为了让依赖方向可检查，不宣称独立版本或对外 API。
- `@sessionmap/runtime` 是唯一可执行应用。`apps/runtime/src/cli.ts` 是唯一 Bun 编译入口，
  `serve`、`install`、`open`、`now` 与后台 watcher 共享同一生命周期和版本。
- `@sessionmap/web` 是 runtime 的 vendored 资产输入，不是独立部署站点。`AssetStore` 在
  构建时嵌入资产，运行时仍只通过受保护的回环服务提供同一地图文档。
- `@sessionmap/desktop` 有独立的 Swift 编译边界，但只是发布容器：不拥有状态、API、
  watcher、IPC 或服务生命周期。

允许的源码依赖方向为：

```text
apps/desktop ──HTTP/WKWebView──> apps/runtime ──> packages/core
                                      │
                                      └──build-time──> apps/web
```

Web 不直接读取状态文件，desktop 不导入 core，core 不反向依赖任何 app。根
`package.json` 是 workspace、产品版本和完整检查入口；三个 workspace package 都是
`private`，不引入独立发布、版本协调或兼容桥。

## 为什么采用 workspace

仓库已有三个不同的构建材料边界：Bun 可执行程序、静态 Web 资产和 Swift 壳；同时 core
已经能从服务组装中分离。用 workspace 表达它们能让源码归属、包级依赖和资源路径显式，
并符合维护者期望的导航方式。收益来自可检查的边界，不来自制造多个产品。

为控制新增复杂度，本次没有拆出更多 package，没有给 Web 增加独立 bundler/dev server，
没有把测试分散进每个 workspace，也没有改变 root release workflow。测试多数验证跨模块
协议，因此继续放在根 `tests/`；构建和安装编排继续由根 `scripts/` 所有。

## 内部模块演进

- 原 `web/app.js` 和 `web/styles.css` 分别为 1248 行与 1329 行，已按 bootstrap、directory、
  intake、actions、lifecycle，以及 foundation、map、intake、indexes、topics、overlays 切片。
  `AssetStore` 仍按固定顺序组合成两个原有公开 URL。
- 状态职责已分为 `state-repair.ts`、`state-store.ts` 与 `instance-lock.ts`：修复保持纯内存
  归一化，StateStore 继续独占串行原子写入，进程锁只保护唯一 runtime 生命周期。旧
  `state.ts` 不保留 facade 或兼容 re-export。
- 模型滚动已分为 `roll.ts` 的 prompt/JSON 协议和 `roll-engine.ts` 的 CLI 探测/执行。
  watcher 仍是唯一编排者，引擎结果仍须经过同一协议校验后才能进入串行 commit gate。
- `watcher.ts` 较长，但 inventory、history/live 调度、keyed worker 与串行 commit gate
  共同守住顺序和单写者协议，当前保持一个所有者。只有其中出现可独立测试、因不同原因
  变化且不共享队列/提交事务的职责，或持续越界修改时，才重新评估拆分。
- 构建脚本从 `import.meta.dir` 推导绝对路径，不依赖调用者 cwd；所有资源路径均显式指向
  workspace，路径契约由测试和 CI 覆盖。workspace fitness test 同时扫描源码 import 与
  持久状态敏感标记，阻止 core 反向依赖 apps、Web/desktop 绕过 runtime 边界。

## 迁移与回滚

这次迁移只移动源码和调整包解析，不迁移 `state.json`，不改变 schema、端口、API、URL、
capability、launchd label、binary 名称、App bundle id 或安装目标。回滚可将目录恢复到原
位置并还原 root package/tsconfig/脚本路径；持久状态和已安装版本无需转换。

Web 切片仍可按 `AssetStore` 清单连接回单文件；完整 bundle hash、浏览器解析、standalone
编译、App 构建和发布配置共同提供回滚证据。决策记录见
[ADR 0013](decisions/0013-private-workspace-modular-monolith.md)，它替代了
[ADR 0012](decisions/0012-keep-single-package-modular-monolith.md) 的单 package 目录选择。
