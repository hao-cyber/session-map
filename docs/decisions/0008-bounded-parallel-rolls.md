# ADR 0008：有界并行 Roll 与串行语义提交

> 状态：部分被 [ADR 0014](0014-short-commit-gate-and-priority-lanes.md) 替代
> 日期：2026-07-20

## 背景与约束

首次历史导入会包含数十到数百个彼此独立的 session。现有 watcher 把读取、模型调用、游标
提交和树写入放在一个串行 worker 中；rolling snapshot 虽然把单次输入限制在 12 KiB，仍然
需要逐个 session 调用模型，因此 478 个 session 的总耗时不会因输入有界而消失。更重要的是，
一个三分钟模型调用会让新产生的 live 增量在同一队列中等待，形成“后台导入阻塞正常使用”。

并行化必须继续满足：同一 session 的增量严格有序、模型拥有 mainline/转折/ask 语义、
`TreeRuntime` 是唯一树写边界、offset-before-apply 的 at-most-once 取舍、单状态文件原子替换、
失败暂停和重启恢复，以及 live 工作不被历史回填饿死。

## 备选方案

- **维持全串行**：最容易推导，但历史吞吐和 live 延迟都受最慢模型调用支配。
- **直接 `Promise.all` 后应用结果**：吞吐高，但两个输出可能基于同一旧树创建别名主线或引用
  已变化节点，破坏模型语义与单写者协议。
- **拆成 session-local 模型与全局 linker 两次模型调用**：边界最纯，但每个 session 固定增加
  一次外部调用；在当前本地 CLI 启动开销下，收益未经基准证明。
- **有界乐观 Roll + 串行校验提交**：独立 session 可并行调用；提交前验证输出依赖的 source /
  target 主线是否仍与分析时一致，过期时只重算该项。

## 决策

采用有界乐观 Roll + 串行语义提交：

- watcher 运行最多三个模型 worker；history 最多占两个槽，第三个槽保留给 live。队列始终把
  live 放在 history 前，非抢占；已经开始的模型进程允许收口。
- `provider + logical session id` 是顺序键。同一键同一时刻最多一个在途项；不同键才可并行。
- worker 从有界 transcript delta 和当时的树投影构建 prompt。模型输出只是候选结果，不直接
  写状态。
- 所有 offset/history cursor 提交与 `TreeRuntime.applyRoll` 进入同一个串行 commit gate。
  gate 比较候选所依赖的 source root、目标 root 和新主线集合；依赖发生语义变化时，用最新
  状态在 gate 内重新调用模型，再提交。
- 无正文、低信号和自生成增量仍跳过模型，但使用同一顺序键与提交规则。
- history 失败会耐久暂停 job。其他在途 history 结果在 gate 发现 job 已暂停/取消时丢弃，
  不推进 cursor；继续或重启后从已提交 cursor 重做。live 失败只写冷却，不影响 history 状态。

## 所有权、数据流与安全边界

```text
priority queue ─► keyed bounded roll workers ─► untrusted candidates
                                              │
                                              ▼
                                      serial commit gate
                                              │
                     cursor owner ────────────┼──► TreeRuntime（唯一树写者）
                                              ▼
                                      atomic state.json
```

并发只存在于只读 transcript 解析和无状态外部模型调用。状态游标仍由 watcher 写，树仍只由
`TreeRuntime` 写；Web/API 不获得新的写入口。模型候选仍经过既有 schema、长度、子树 capability
与状态机校验。队列有固定并发上限，不引入无界内存或进程增长。

## 失败、重启、迁移与回滚

- 进程退出时在途候选没有耐久副作用；重启从最后提交的 live offset/history cursor 继续。
- commit gate 先持久化消费位置再应用非幂等 ops，保留原有窄窗口“可少一次、不可重复 grow”。
- pause/cancel 不强杀模型 CLI；晚到候选因 job id、状态和 cursor 校验而失效。
- 不增加持久 schema 字段，旧状态无需迁移。回滚到 ADR 0006 的串行 watcher 时，既有 cursor、
  imported 集合和树仍可直接读取。
- 若真实运行发现本地引擎不支持并发，只需把并发常量降为 1；写入协议和状态无需回滚。

## 验证证据

- 单元测试证明不同 session 的 history roll 会重叠、同一 session 不重叠、live 可使用保留槽。
- stale candidate 测试证明相关主线变化后会重算，未变化的独立主线不重复调用。
- pause/cancel 测试证明晚到候选不推进 cursor、不写树；重启和 offset-before-apply 测试继续通过。
- `bun run check` 覆盖类型、Web 资产、全部测试、standalone CLI 与 macOS App 构建。

## 后果

首次导入不再等价于 478 次完全串行等待，live 也不需要排在整个历史队列之后。代价是 watcher
增加显式 worker/commit gate 和 stale 重算分支；热点主线上的并发候选可能被重算，因此吞吐
上限由工作是否真正独立决定，而不是承诺固定倍速。
