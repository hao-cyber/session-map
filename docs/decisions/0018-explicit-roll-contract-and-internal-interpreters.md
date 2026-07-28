# ADR 0018：显式 Roll 契约与内部解释器

## 状态

已实现。

## 背景

Roll 数据流已经守住单写者和短提交闸门，但三个不同原因变化的职责仍混在较大文件中：
模型可见的 JSON 契约与 prompt 文案/兼容解析同住 `roll.ts`；live 和 history 各自复制过期候选
重算循环；`TreeRuntime.applyRoll` 同时编排 session 事务并逐条解释树操作。重复与文件热点
开始增加协议漂移风险，但这些机制都不需要新的持久状态或公开 package。

## 约束

- 模型继续决定 mainline、结构转折和 ask；runtime 只守 ID、schema、边界与副作用。
- Watcher 必须继续独占队列、history/live cursor、优先级和串行 commit gate。
- `StateStore.update` 仍是唯一持久写入入口；offset-before-apply 与原子替换顺序不变。
- stale retry 的模型调用不得占用 commit gate，重算次数必须有界。
- 不改变 schema、状态文件、CLI/API、迁移路径或发布边界。

## 备选方案

### A. 保持现状

没有迁移成本，但协议文案/解析、两套候选循环和树事务会继续因不同原因共同变化，重复容易
产生 live/history 行为差异。

### B. 拆成新的 package、服务或通用工作流框架

形式边界更强，但只有一个真实消费者，会增加 facade、依赖层级或第二生命周期，违反模块化
单体与“不为未来扩展预建抽象”的约束。

### C. 在 core 内提取三个纯机制，保留原 owner

让可独立测试的协议、候选循环和 op 解释器各有一个事实源，同时不移动队列、事务或数据所有权。

## 决定

采用方案 C：

1. `roll-contract.ts` 唯一拥有模型可见的 output shape、允许操作列表、runtime contract 和兼容
   JSON 解析。`roll.ts` 只组合语义指令与有界上下文，`roll-engine.ts` 只执行 CLI 并调用该解析器。
2. `roll-candidate.ts` 拥有投影 fingerprint、新鲜度判断和有界 stale retry 循环。调用方注入
   invoke 与 validate/commit；模块本身不读取 transcript、不持有 queue/cursor，也不写状态。
3. `tree-roll.ts` 解释并修改 TreeRuntime 传入的内存草稿。session 归属、snapshot-only 边界、
   删除/归档和唯一 `StateStore.update` 事务仍由 `tree.ts` 持有。

依赖方向保持 `watcher → roll/roll-candidate/tree → state-store`；三个新模块都不能反向依赖
watcher、apps 或持久化入口。

## 后果

- 正向：模型 I/O 契约只有一个来源；live/history 使用相同 stale budget 和重算时序；树操作可在
  不建立第二写入者的前提下独立审阅。
- 代价：core 内增加三个有明确边界的小文件，调用点需要显式注入状态与副作用。
- 失败与重启：模型失败、候选持续过期、commit 竞争和进程崩溃仍走原 watcher/StateStore 协议；
  没有新增内存队列或耐久事实，重启仍从原 offset/history cursor 恢复。
- 安全：模型输出仍是不可信输入；跨主线 node id、非法状态迁移和 reattach 写入继续由同一 op
  解释规则拒绝。新模块不扩大 loopback capability 或文件访问面。
- 迁移：无 schema 或数据迁移。
- 回滚：可把三个纯机制内联回原调用者；`state.json`、offset、节点 ID 和安装产物无需转换。

## 验证

- parser 特征测试覆盖直接、fenced、wrapped、缺省 ask 与非法 shape。
- candidate 单元测试固定 initial/stale-retry 顺序和最大尝试次数；watcher 集成测试继续证明模型
  不占 commit gate、live/history 竞争时会重算且 offset 不重复前进。
- TreeRuntime 既有特征测试继续覆盖 op 接受/拒绝、跨主线防护、snapshot-only 和 reattach。
- `bun run check` 覆盖类型、依赖 fitness tests、全量测试与 standalone/App 构建。
