# 桌面展示容器模块

## 职责

让同一份 SessionMap 地图文档拥有稳定、可召回的桌面窗口，同时保留系统浏览器作为完整
基线。浏览器安装式 Web App 和 macOS 极薄壳只是展示容器，不拥有工作主线、session、
动作编排或服务生命周期。

## 代码入口

- `apps/web/src/manifest.webmanifest`、`apps/web/src/sessionmap-icon.svg`：浏览器安装 metadata 与本地图标。
- `apps/desktop/src/SessionMapApp.swift`、`apps/desktop/src/Info.plist`：AppKit/WKWebView 极薄壳。
- `scripts/build-macos-app.ts`：原生架构或 universal App bundle 构建、图标和本地签名。
- `apps/runtime/src/now.ts`、`apps/runtime/src/cli.ts`：行动优先级的只读终端投影与编号跳转入口。
- [`../decisions/0004-map-document-desktop-hosts.md`](../decisions/0004-map-document-desktop-hosts.md)：
  容器所有权、失败与回滚决策。

## 不变量

- 正式界面始终是 Bun 服务提供的同一份地图文档。浏览器 tab、installed Web App 和
  WKWebView 不得分叉 HTML、读取模型、动作 API 或业务状态。
- 壳只允许导航到 `http://127.0.0.1:4317`；外部链接交给系统浏览器。不得注入 JS bridge、
  preload、文件系统、shell、token 或第二条业务 IPC。
- App 发现服务不健康时只调用同一个 `sessionmap install` 事务。launchd 仍是唯一后台
  所有者；App 不直接 spawn `serve`，不生成第二份 plist，不读写 `state.json`。
- App 只持久化窗口几何和用户显式的“保持在最前面”偏好。默认不置顶、不自动通知、
  不创建菜单栏状态项。
- installed Web App 的 `start_url` 是固定根地址。它直接读取服务的真实 snapshot，不保存
  capability、不注册 service worker、不复制离线状态；浏览器不支持安装时页面仍完整可用。
- `sessionmap now` 复用 `buildNowItems`，只读修复投影且不落盘。`--jump N` 必须调用现有
  loopback `/api/jump`，不能在短命 CLI 中构造 ActionRouter 或成为第二写者。
- 同一主线已有明确 ask 时，行动优先级投影不再重复显示较低优先级的 blocker/busy/recent 状态。

## 失败与重启

- 关闭、崩溃或卸载展示容器不影响 watcher、tree、offset 或 session 入口。
- 冷启动时服务健康则直接加载固定地址；服务不健康则由 CLI install 完成原子替换、健康
  检查和回滚。失败留在壳原位显示可执行错误，不展示演示数据。
- App 只通过 Dock、Spotlight 或安装后的自动打开召回；`sessionmap open --browser` 继续
  专注真实浏览器的 ticket/ready 协议。壳不注册 URL scheme，也不进入浏览器握手职责。
- 降级到没有 App 的旧发布不迁移用户状态；浏览器入口仍可使用。

## 验证

- `bun run check` 必须 typecheck Swift、构建当前架构 App、验证 manifest 与无远程资产。
- 发布构建同时生成 arm64/x86_64 standalone CLI 和 universal App 壳，分别检查 Mach-O
  架构、签名，并随同一个 `.pkg` 公证。
- 真实验收覆盖：Dock 冷启动、单实例 reopen、窗口位置恢复、默认不置顶、显式置顶、服务
  未运行时统一 install、服务重启后恢复、Dock reopen、外部导航不进入壳。
- 用代表性桌面尺寸分别截取普通浏览器与 App，检查主题/session/脉络层级、纵向滚动、溢出、命中区、
  披露反馈和窗口最小尺寸。截图与 QA 报告不得进入发布产物。
