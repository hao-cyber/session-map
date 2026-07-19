# 安全策略

SessionMap 会读取本机 AI coding agent transcript，并能在用户显式操作后聚焦、复活终端，或通过 Orca 向终端发送文本。因此，以下问题属于高敏感安全问题：

- 绕过 capability token 或 Origin 校验；
- 静态文件路径穿越；
- 修改被监控 transcript；
- resume / AppleScript / shell 命令注入；
- 未经本机用户显式点击触发终端副作用；
- 模型输出越权修改其他主线；
- 页面标签、session 标题或 git 字段造成 HTML / Markdown 注入。

请通过 GitHub Security Advisories 私下报告漏洞，不要在公开 issue 中附带真实 transcript、capability token、用户名、本机路径或 session id。

当前只支持最新 tag 对应的发布线。SessionMap 只监听 `127.0.0.1`；把它暴露到局域网、公网或反向代理之后的风险不在默认威胁模型内。

## 默认安全边界

- 被监控的 JSONL 永远只读打开。
- 除同源的一次性 `/api/open/exchange` 外，业务 `/api/*` 全部要求权限为 `0600` 的 capability token。公开根页面和 URL 都不包含 token；`sessionmap open` 只把 30 秒有效、可单次兑换的签名 open ticket 放进不会随请求发送的 URL fragment。页面立即清理地址栏，兑换后的 token 仅保存在当前标签页的 `sessionStorage`；ticket 会在首次渲染回执成功后删除。
- POST 只接受 loopback Origin、`application/json`、不超过 64 KiB 的 JSON object。
- 页面和 Markdown 对 HTML 与 Markdown 元字符做双层转义。
- 模型 op 必须通过 schema、主线子树授权和 reattach 写边界。
- 跳转、复活、发话只允许来自本机页面的显式交互。
- Web runtime 不包含 CDN、遥测或外部数据上报。
