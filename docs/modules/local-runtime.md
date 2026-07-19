# 本地 Web 运行时模块

## 职责

提供唯一 Bun 后台、本地 HTTP 页面、CLI 入口和 launchd 生命周期。产品界面直接运行
在系统浏览器中，不维护 SwiftUI、WKWebView、菜单栏或其他原生客户端。

## 代码入口

- `src/app.ts`：组装状态、watcher、动作层和 HTTP 服务。
- `src/server.ts`：回环 Web 服务、本机同源请求和 API 边界。
- `src/open.ts`：浏览器选择、短期签名 ticket 和首帧回执等待。
- `src/launchd.ts`：standalone CLI 的安装、启动、停止与健康检查。
- `src/cli.ts`：`serve`、`install`、`open`、`status` 等命令入口。

## 不变量

- 浏览器、CLI 与 watcher 共享一个 Bun 服务和一个状态文件。
- 默认只监听 `127.0.0.1`；不得把“网页可多端”解释为自动开放局域网访问。
- 同一用户在本机任意现代浏览器、任意 profile 或新标签页直接打开
  `http://127.0.0.1:4317/`，都能读取唯一服务中的同一份真实状态；读取不得依赖某个 tab
  的 token、`sessionStorage` 或预先运行 `sessionmap open`。`localhost` 只作等价别名，
  默认地址保持 `127.0.0.1` 以避免 IPv4/IPv6 解析差异。
- `sessionmap open` 通过 URL fragment 只传递 30 秒一次性签名 ticket，不传递长期
  数据访问凭据。页面同源登记、清除 fragment，并在首次快照和地图完成后发送 ready；
  CLI 收到 ready 才报告成功，`/usr/bin/open` 退出只表示系统接收了投递请求。
- 默认使用系统默认浏览器；`--browser APP` 可指定任意已安装的 macOS 浏览器应用，
  常用别名为 chrome、safari、firefox、edge、brave、arc。协议与页面不得依赖某个
  浏览器进程、profile 或自动化接口。
- open ticket 失效只影响 CLI 的打开回执，不得阻断页面直接读取；网络中断与服务短暂
  重启使用“暂时无法刷新”，并保留最后一次成功渲染。
- launchd 保持单 writer；新服务健康前不得移除旧服务入口。
- macOS Terminal/iTerm/Orca 集成只是动作适配层，不构成第二个产品客户端。

## 验证

运行 `bun run check`，构建 standalone CLI，以隔离或真实状态目录验证 `install`、任意
新浏览器 tab 直接读取真实 snapshot、open ticket 一次登记、伪造/过期拒绝、首帧 ack、
无 ack 超时、服务重启重试、`/health`、静态资产版本隔离和 launchd 重启。UI 变更仍需在真实浏览器生成代表性
桌面截图，并至少验证默认浏览器与一个显式 `--browser APP` 入口；验收浏览器必须
包含已有旧缓存的真实 profile，不能只用无缓存自动化 profile。
