# ADR 0017：把 Provider Memory Summary 作为有界语义提示

## 状态

已实现。

## 背景

SessionMap 的主题归属、session 主标题、最新进展和主题脉络都由持续 roll 提炼。只依赖最近
一段 transcript 容易让早期偏差沿旧 snapshot 延续；反复重读完整 transcript 又会显著增加
token、延迟和持续运行成本。部分 agent CLI 已维护自身的 memory summary，但它可能陈旧、
覆盖失败原因，或无法可靠证明属于哪个可恢复 session。

## 约束

- 用户不应为后台持续整理承担过多 token 成本；常态路径必须有稳定、可测试的输入预算。
- 完整 transcript / event log 仍是 session 发现、恢复和永久脉络证据的事实源。
- rolling snapshot 可以修订，但不可抹除的主题脉络不能被外部摘要静默改写。
- 同一事实仍只有一个持久写入者；辅助 summary 不建立第二份状态模型或旁路写入。
- 不同 provider 的 memory 格式、更新频率和身份可靠性不同，能力必须由 provider registry
  显式声明，不能靠路径或文件名猜测。

## 备选方案

### A. 每轮重读完整 transcript

语义覆盖最完整，但 token 与延迟随 session 长度持续增长，不适合作为后台常态路径。

### B. 完全信任 provider memory summary

成本最低，但会把来源不明、可能过期且会覆盖历史的摘要提升为事实源，破坏对象恒存和
可追溯性。

### C. 完全忽略 provider summary

边界最简单，但浪费 provider 已完成的压缩结果，也无法缓解仅凭最近增量滚动造成的语义漂移。

### D. 把 provider summary 作为有界、非权威提示

复用低成本语义压缩，同时要求 transcript 证据守住主题与永久脉络。复杂度集中在 adapter
身份绑定、新鲜度和冲突处理，符合现有 provider registry 与统一 roll 边界。

## 决定

采用方案 D。

Provider adapter 可以暴露一个可选 summary hint，但必须同时给出准确的 provider、session
身份与可比较的新鲜度。Watcher 只在 hint 新于已处理版本时把它交给统一 roll，不直接写入
`state.json`。常态 roll 的输入由以下内容组成：

1. 有界新增 transcript；
2. 上一版 session rolling snapshot；
3. 当前主题子树；
4. 少量既有主题候选；
5. 可用且已验证身份与新鲜度的 provider summary hint。

Summary hint 可以帮助模型修订 session 整体主标题、最新进展、因果路标，并调整主题候选
排序。仅有 summary hint 而没有 transcript 证据时，roll 不得迁移 session 的主题，不得 grow、
close、block、unblock、rename 或 refocus 永久脉络节点。出现低置信、主题候选冲突或 summary
与 transcript 矛盾时，系统可以有界扩大 transcript 证据窗口；冲突裁决始终以 transcript
与已经持久化的轨迹为准。

## 后果

- 正向：常态 token 成本与 session 总长度解耦；标题和当前进展可以利用 provider 已有压缩，
  同时保留 SessionMap 对主题和脉络的证据标准。
- 代价：provider registry 需要声明 summary capability；状态需记录每个 hint 的已处理版本或
  新鲜度；roll 协议需要区分“仅可修订 snapshot”与“有 transcript 证据可修改结构”的轮次。
- 失败恢复：summary 缺失、损坏、身份不明或 adapter 不支持时，退化为现有 transcript 增量
  roll，不影响 session 恢复、offset 或既有地图。
- 迁移：现有状态无需立即迁移；新增 hint 游标必须是可选字段，旧状态按“未处理过 hint”读取。
- 回滚：停止发现和注入 summary hint 即可恢复原路径；不得删除已经持久化的 snapshot 或轨迹。

## 验证

- 同一 hint 不重复触发 roll，重启后仍保持 at-most-once。
- 无 transcript 证据的 hint 只能修改 rolling snapshot，不能迁移主题或修改永久脉络。
- hint 与 transcript 冲突时，输出遵循 transcript，并保留已有关闭原因与修订关系。
- 常态 prompt 在固定预算内；只有规定的低置信或冲突路径允许有界扩窗。
- hint 缺失、损坏、过期或身份无法验证时无损退化到 transcript 增量路径。

当前实现只启用两种能可靠绑定 session 的来源：Grok session 同目录的 `summary.json`，以及
Codex transcript 内的 `compacted` 记录。Claude 项目级 `MEMORY.md` 无法证明属于单个 session，
Kimi 当前也没有已验证的独立 summary 协议，因此两者保持关闭，直到 provider registry 能
提供同等身份与新鲜度证据。
