# Session 跳转与恢复模块

## 职责

把每个 session 的实时运行状态和可靠动作暴露给读取层：运行时快速切换到原终端，关闭后
用原 provider 协议恢复会话。切换与恢复是 SessionMap 的核心功能；Orca 可提升体验，
但缺失时仍必须正常工作。

## 代码入口

- `packages/core/src/actions.ts`：动作决策、实时进程重解析和安全降级顺序。
- `packages/core/src/orca.ts`：可选的 Orca 查询、切换、创建与发话。
- `packages/core/src/monitor.ts`：PID、TTY、cwd、provider 与 transcript 身份证据。
- `apps/runtime/src/server.ts`：受回环客户端、同源 Origin 与严格 JSON 边界保护的动作 API。

## 不变量

- Session 行不提供脉络按钮，单击不改变主题脉络或 Sessions 目录的披露状态。双击以及
  行尾按实时状态显示的“回到终端”或“恢复终端”按钮必须真实切换或恢复，不能用无动作
  的视觉反馈冒充成功。
- Session 行可提供独立的删除记录控制；它不调用 provider 删除、不修改 transcript，必须
  二次确认并准确说明唯一主题与共享主题的不同清理范围。
- 每次动作前重新验证进程身份；不得信任持久化的陈旧 PID。
- 快速路径命中已知 Orca handle 或 PID 时只做一次现场验证，不先扫描全部 provider；
  快速路径失效后才并行刷新 Orca、打开 source 与进程证据，避免串行叠加点击延迟。
- 初始进程没有 session ID 时，只用其只读打开的 transcript 建立精确关联；Codex 与
  Claude 的 `lsof -c` 必须分别查询再合并，不能让一个 provider 无进程时的退出码
  抹掉另一个 provider 的有效证据。
- 持久 terminal handle 与 PID 只用于快速定位。Orca 必须现场验证 handle；PID 必须用
  单进程 `lsof` 现场核对 provider + session transcript，失败后才并行刷新全量证据。
- 模糊匹配必须同时满足 provider、cwd 且结果唯一；歧义时停止，不切错终端。
- 降级顺序是精确 Orca → 精确系统 TTY → 安全的新终端恢复。
- 新终端恢复必须由 provider registry 生成原生命令，并保留原 session ID、cwd 与必要的
  provider home：Claude `claude --resume`、Codex `codex resume`、Kimi `kimi --session`、
  Grok `grok --resume`、社区 MiniMax CLI `minimax --resume`。
- 没有完整 cwd、合法 session ID 或已知恢复协议时，入口必须返回明确错误；不得退化为
  新建普通 CLI、猜 cwd、模糊匹配相似 session 或显示虚假成功。
- 页面与服务端动作入口必须对同一 session 的在途跳转去重，避免跨 tab 或双击明确按钮
  触发两次恢复。
- 测试关闭检测时只操作专用测试终端，绝不关闭用户其他终端。

## 验证

自动覆盖集中在 `tests/render-actions-server.test.ts` 和 `tests/monitor.test.ts`；发布前还要
使用一个隔离的真实 Claude 或 Codex session 验证运行、切换、关闭与恢复。
