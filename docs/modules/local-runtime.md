# 本地 Web 运行时模块

## 职责

提供唯一 Bun 后台、本地 HTTP 页面、CLI 入口和 launchd 生命周期。产品界面直接运行
在系统浏览器中，不维护 SwiftUI、WKWebView、菜单栏或其他原生客户端。

## 代码入口

- `src/app.ts`：组装状态、watcher、动作层和 HTTP 服务。
- `src/server.ts`：回环 Web 服务、capability 和 API 边界。
- `src/launchd.ts`：standalone CLI 的安装、启动、停止与健康检查。
- `src/cli.ts`：`serve`、`install`、`open`、`status` 等命令入口。

## 不变量

- 浏览器、CLI 与 watcher 共享一个 Bun 服务和一个状态文件。
- 默认只监听 `127.0.0.1`；不得把“网页可多端”解释为自动开放局域网访问。
- `sessionmap open` 只通过 URL fragment 引导 capability，随后由页面清除地址栏。
- launchd 保持单 writer；新服务健康前不得移除旧服务入口。
- macOS Terminal/iTerm/Orca 集成只是动作适配层，不构成第二个产品客户端。

## 验证

运行 `bun run check`，构建 standalone CLI，以隔离或真实状态目录验证 `install`、`open`、
`/health`、鉴权页面和 launchd 重启。UI 变更仍需在真实浏览器生成代表性桌面截图。
