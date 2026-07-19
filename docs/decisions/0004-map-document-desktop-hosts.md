# ADR 0004：同一地图文档允许多个无状态展示容器

> 状态：已采纳  
> 日期：2026-07-20  
> 替代：[ADR 0001](0001-standalone-release-channels.md) 中“不生成 App、系统浏览器是唯一容器”的部分；
> 其余 standalone CLI、单写者、安装事务与回滚决策继续有效。

## 背景与约束

SessionMap 的北极星是让用户切回任意工作主线时，三秒找回此前的思考位置。系统浏览器
提供了成熟、安全且跨 profile 的完整阅读面，但普通标签缺少稳定的 Dock 身份和独立窗口，
容易被大量工作标签淹没。全屏 TUI 会与 agent 工作终端争夺空间；小浮窗、PiP 和默认置顶
又不足以承载稳定的主题 → session → 脉络目录。

当前实现已经把真正不可复制的边界放在 Bun 服务：唯一 `state.json`、唯一 watcher、唯一
写入者、统一 HTTP 动作协议和回环 Origin 门禁。Web 页面只渲染服务端投影并保存滚动、披露
和局部相机等读取偏好。因此“避免第二套状态模型”不要求“只能由一个窗口技术承载页面”。

## 决策

- 唯一正式产品界面定义为**由本机 Bun 服务提供的同一份地图文档**，而不是某一种窗口
  技术。系统浏览器、浏览器安装式 Web App 和 SessionMap macOS 极薄壳都可以承载它。
- 系统浏览器仍是完整支持的基线与故障回退。任意本机现代浏览器、profile 或新标签页可
  直接读取同一 snapshot；`sessionmap open` 的 ticket 只登记首次可见帧回执。
- Web bundle 提供 manifest、图标和 standalone display metadata，使支持的浏览器能把
  同一页面安装成独立窗口。不得加入 service worker、远程资产或离线复制状态。
- macOS App 只拥有窗口生命周期、窗口几何和用户显式的置顶偏好。它通过同一个 CLI
  `install` / `open` 协议确保服务健康并加载 ticket URL；不读取 `state.json`、不持有
  capability secret、不增加业务 IPC、不缓存 snapshot、不启动第二 writer。
- `sessionmap now` 是 Now 状态条的只读终端投影和动作入口，不是第二套地图。它复用
  `buildNowItems` 排序；跳转通过现有 loopback API 交给后台 ActionRouter。
- 默认不置顶、不自动通知、不创建菜单栏常驻项。桌面伴随表示稳定可召回，不表示持续
  抢占注意力。
- Electron 与完整 TUI 暂不进入正式路线。若未来跨平台壳或纯终端主界面需求有真实证据，
  另立 ADR，不在当前壳中预建抽象。

## 数据流与所有权

```text
sessionmap now ───────────────┐
系统浏览器 / installed web app ├─► 同一个 loopback HTTP 协议
macOS 极薄壳中的 WKWebView ───┘              │
                                              ▼
                                 Bun service / ActionRouter
                                              │ 唯一写入
                                              ▼
                                          state.json
```

用户从 Dock 打开壳时，壳先检查 `/health`：健康则直接加载固定根地址；不健康则只调用
已安装 CLI 的统一 `install` 事务，成功后再加载根地址。App 仅通过 Dock、Spotlight 或
安装后的自动打开召回；`sessionmap open --browser` 仍只服务真实浏览器的 ticket/ready
协议。壳不注册 URL scheme、不伪装浏览器，也不接触长期 capability。

## 失败、重启与安全

- 服务未运行时，App 只调用同一个 `sessionmap install` 事务；健康失败沿现有 launchd
  回滚，壳不自行 spawn 第二服务。
- App 或 WebView 崩溃不影响 watcher、树或 offsets；重新打开后直接读取 Bun 服务的真实
  snapshot。
- App 只允许顶层导航到 `http://127.0.0.1:<固定端口>`；其他 URL 交给系统浏览器，不把
  本地页面提升为可执行原生权限。
- App 不注入 preload bridge，不向页面暴露 Swift、文件系统、shell 或 token。
- 任意本机浏览器可读是明确的本地信任选择；写请求仍必须携带浏览器生成的精确 loopback
  Origin、严格 JSON media type 和有界 object body。服务不发送 CORS 许可。

## 分发、迁移与回滚

- `.pkg` 同时安装已签名 standalone CLI 和无状态 `/Applications/SessionMap.app`，随后仍
  只调用 CLI 的统一 install 事务。Homebrew 与源码用户可继续只使用浏览器入口。
- App 与 CLI 分别签名，作为同一个 `.pkg` 一起公证；App 不携带第二份状态或 launch agent。
- 从带 App 的版本降级到 CLI-only 版本时，用户状态无需迁移；旧 App 若仍存在，只会尝试
  打开兼容的 loopback 文档。卸载 App 不影响状态与服务。
- 回滚发布只替换可执行文件和 App；不得删除 `state.json`、offset 或 capability secret。

## 验证证据

- `sessionmap now` 的顺序与 Web Now 条来自同一投影，空状态、JSON 和编号跳转均有测试。
- manifest、图标、无远程依赖和 standalone metadata 进入 Web 资产版本哈希与回归测试。
- App 构建验证架构、Info.plist、无嵌入业务状态、受限导航和 CLI open 调用；代表性桌面
  尺寸截图验证与浏览器读取面一致。
- standalone CLI、App、`.pkg` 安装、launchd 重启、冷启动、首帧回执和恢复路径全部冒烟。

## 后果

SessionMap 获得稳定 Dock 身份和独立窗口，同时保留浏览器可移植性与单写者架构。代价是
增加一小段 macOS AppKit/WebKit 壳、App 签名与窗口级 QA。任何把业务状态或动作复制进壳
的需求都必须被拒绝或另行修改本决策。
