# ADR 0003：回环浏览器采用本机用户信任边界

> 状态：已采纳
> 日期：2026-07-20

## 背景与约束

SessionMap 是只绑定本机回环地址的单用户应用。旧实现要求每个浏览器标签页先通过
`sessionmap open` 兑换长期 capability；用户手动打开固定地址、换浏览器或新建 profile
时，页面虽然可见，真实 snapshot 却返回 401。这违反“任意本机浏览器直接进入同一份
真实状态”和三秒恢复契约。

边界仍必须满足：唯一 Bun 服务与状态文件、只绑定 `127.0.0.1`、不开放局域网、无 CORS、
transcript 只读、副作用必须来自页面明确操作，且 CLI 仍能确认首帧真正完成渲染。

## 备选方案

1. 保留每 tab capability：隔离更细，但固定地址不是可靠入口，直接违反产品能力。
2. 把长期 token 嵌入 HTML、Cookie 或 URL：直开方便，却扩大泄露、日志和跨 profile 状态面。
3. 明确采用本机用户信任边界：浏览器直接读取，写操作由回环连接、同源 Origin 和严格
   请求形状保护；open ticket 只负责 CLI ready 回执。

## 决策

采用方案 3：

- 固定入口为 `http://127.0.0.1:4317/`；`localhost` 仅作可用别名，避免把 IPv6 解析差异
  引入默认路径。
- 根页面、vendored 资产、健康检查和 `/api/snapshot` 对回环客户端直接可用，不要求
  浏览器 token。不同浏览器和 profile 始终读取唯一 runtime 的真实持久状态。
- 所有状态变更 POST 继续要求同端口回环 HTTP Origin、`application/json`、准确且不超过
  64 KiB 的 `Content-Length` 和 JSON object body。服务不发送 CORS 许可。
- 请求 URL hostname 和实际 client IP 都必须是回环；服务继续只绑定 `127.0.0.1`。
- `sessionmap open` 是便利入口和可见帧确认，不是授权入口。签名 ticket 只登记 open ID；
  `/api/open/status` 仍要求状态目录中权限为 `0600` 的签名密钥，密钥不进入浏览器。
- CSP、`frame-ancestors 'none'`、文本转义、动作在途去重与 transcript 只读边界保持不变。

## 安全与后果

浏览器同源策略阻止外部网页读取 snapshot；严格 Origin 与 JSON media type 阻止跨站表单
伪造动作；回环 hostname 与 client IP 双校验降低 DNS rebinding 和错误代理暴露风险。
同一操作系统用户下的其他本地进程可以访问服务，这是本决策明确接受的信任边界：它们
本就能读取用户状态文件或调用本机 CLI。若未来支持局域网或多用户，必须另行设计身份、
加密传输与权限，不得扩展本决策。

没有状态 schema 或数据迁移。回滚只需重新安装上一版 binary；`state.json` 和既有
`capability.token` 均可原样保留，后者继续作为 open 回执签名密钥。

## 验证证据

- 无浏览器 token 的 `/api/snapshot` 返回真实状态。
- 新标签页和另一现代浏览器直接打开固定地址后完成首屏渲染。
- 恶意 Origin、错误 media type、非 object JSON 和伪造/过期 ticket 被拒绝。
- CLI open ready、服务重启、完整检查、standalone 构建与本机安装冒烟通过。
