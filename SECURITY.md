# 安全策略

SessionMap 会读取本机 AI coding agent transcript，并能在用户显式操作后聚焦、复活终端，或通过 Orca 向终端发送文本。因此，以下问题属于高敏感安全问题：

- 绕过回环客户端或 Origin 校验；
- 静态文件路径穿越；
- 修改被监控 transcript；
- resume / AppleScript / shell 命令注入；
- 未经本机用户显式点击触发终端副作用；
- 模型输出越权修改其他主线；
- 页面标签、session 标题或 git 字段造成 HTML / Markdown 注入。

请通过 GitHub Security Advisories 私下报告漏洞，不要在公开 issue 中附带真实 transcript、open ticket、签名密钥、用户名、本机路径或 session id。

当前只支持最新 tag 对应的发布线。SessionMap 只监听 `127.0.0.1`；把它暴露到局域网、公网或反向代理之后的风险不在默认威胁模型内。

## 默认安全边界

- 被监控的 JSONL 永远只读打开。
- 本机用户是默认信任边界。服务同时校验请求 URL 为回环 hostname、连接来源为回环地址，
  不发送 CORS 许可；因此任意本机浏览器可以直接读取真实 snapshot，而远程网页受浏览器
  同源策略阻止，不能跨源读取响应。
- `sessionmap open` 只把 30 秒有效、可单次登记的签名 ticket 放进不会随请求发送的 URL
  fragment。页面立即清理地址栏；ticket 只用于首次渲染 ready 回执。`0600` 的
  `capability.token` 是该回执的本机签名密钥，不会返回给浏览器或作为业务 API 凭据。
- POST 只接受 loopback Origin、`application/json`、不超过 64 KiB 的 JSON object。
- 页面和 Markdown 对 HTML 与 Markdown 元字符做双层转义。
- 模型 op 必须通过 schema、主线子树授权和 reattach 写边界。
- 跳转、复活、发话只允许来自本机页面的显式交互。
- Web runtime 不包含 CDN、遥测或外部数据上报。
