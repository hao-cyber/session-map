# ADR 0011：显式 session 删除与开源仓库隐私门禁

> 状态：已接受
>
> 补充 [ADR 0009](0009-theme-controls-lineage-session-controls-terminal.md) 中 Session 行只出现终端
> 动作的交互裁决；删除记录作为独立隐私控制，不赋予 Session 主题脉络所有权。

## 背景与约束

SessionMap 默认保留工作轨迹，但用户状态包含 session 标题、最近用户文本、cwd、transcript
路径和模型派生摘要。产品准备开源时必须同时满足两件事：运行时数据不能进入源码/发布物；
用户必须能明确删除 SessionMap 中的某条 session 记录。Transcript 仍是 provider 拥有的只读
恢复源，SessionMap 不得越权删除。

现有主题树允许多个 session 共同生长、关闭或重命名节点，却没有逐字段变更来源归属。因此，
删除共享主题中的单个 session 时，系统不能证明某个既有节点是否只来自该 session。

## 决策

- `state.json` 继续是唯一事实源，TreeRuntime 继续是唯一写者。
- 显式删除清除 session 记录、对应 offset、imported 标记和 history item，并写入最小化的
  `provider:sessionId → deletedAt` 排除标记。
- Watcher 在 inventory、history 选择、live 排队、commit gate 与失败冷却写入前检查排除标记。
  已在途的模型输出不能在删除后复活 session。
- 若主题没有其他 session，删除整棵主题树；若仍有其他 session，保留共享主题树并在确认
  文案中明确说明。当前版本不声称对共享派生内容完成逐字段擦除。
- 原始 transcript 永远不修改。若用户还要删除 provider 原始记录，应在对应 provider 中操作。
- 编译只嵌入显式 Web 资产。Git 隐私检查拒绝 runtime 状态、状态目录前缀（`.sessionmap*` /
  `.maintrail*`）、截图/捕获目录、本地 UI baseline 图像、本机用户绝对路径和常见密钥形态；
  这些检查进入 `bun run check` 与发布质量门禁，并由 `.gitignore` 同步排除。CI 与 Release
  另用固定版本及 SHA-256 的 Gitleaks 扫描全部可达历史，补足 provider 与通用凭据规则。
- StateStore 在任何落盘前拒绝 Git worktree 内的状态目录，包括显式 `--state-dir`。因此真实
  主题、session、脉络、快照与 offset 不会因开发或截图配置错误成为仓库文件。

## 备选方案

- **只删 session 行，不留排除标记**：来源继续增长后会重新出现，拒绝。
- **删除原始 transcript**：破坏 provider 所有权与只读边界，拒绝。
- **删除共享主题整棵树**：会抹除其他 session 的有效工作轨迹，拒绝。
- **假设节点只属于最后写入 session 并精确清理**：现有模型允许跨 session 修订节点，该归属
  不可证明，拒绝。
- **立即引入逐字段事件溯源**：能提供更强擦除语义，但会重写状态模型与迁移协议；在真实需求
  证明其必要前不扩大本次边界。

## 失败、迁移与回滚

Schema v5 对旧状态补空排除表，不改变既有对象。删除与排除在一次原子状态替换中提交；崩溃
不会留下“记录已删但可重导”的中间状态。回滚到旧 binary 时未知字段会被旧修复器忽略，已删
session 不会自动恢复，但旧版本也不理解排除标记，因此回滚前不得重新开启 watcher 处理对应来源。

## 验证

- 单 session 主题删除后 session、offset 与主题树都消失，重启后排除标记仍在。
- 共享主题删除一条 session 后其他 session 与主题树保持，确认文案明确范围。
- 原 transcript 保持不变；后续新增和在途 roll 都不能重建被删 session。
- 同源 API、渲染按钮、键盘/双击事件隔离和移动端命中区有回归覆盖。
- 隐私检查证明 Git 历史/当前跟踪集不含状态文件、捕获目录、具体本机 home 路径或常见密钥。
