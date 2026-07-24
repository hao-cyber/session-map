# 状态模型模块

## 职责

维护工作主线、session、因果脉络、归档、显式删除排除标记、live offset、summary hint 版本、
历史摄取任务、rolling snapshot 与 Roll token usage 的唯一持久状态。
本模块实现“不可抹除的思考轨迹 + 可修订的当前快照”，但不替模型决定语义。

## 代码入口

- `packages/core/src/types.ts`：持久 schema 与运行时类型。
- `packages/core/src/state-repair.ts`：空状态创建、旧 schema 修复与不可信持久状态归一化；
  不拥有文件读写。
- `packages/core/src/state-store.ts`：唯一状态加载/更新入口、Git worktree 防护、revision、
  串行更新与 fsync + rename 原子替换。
- `packages/core/src/instance-lock.ts`：唯一 Bun runtime 进程锁；不读取或解释业务状态。
- `packages/core/src/tree.ts`：节点生长、修订、关闭、归档和撤销边界。
- `packages/core/src/constants.ts`：schema 与有界输入常量。

## 不变量

- 一级对象始终是工作主线；session 是其来源与恢复入口。
- 节点只能追加、修订、衰减或归档，不能被系统静默移除；用户显式删除 session 是隐私例外。
- 删除清除 session、offset、import/history 项并写入最小排除标记。唯一 session 的主题树一并
  删除；共享主题树保留，因为当前 schema 无法证明逐字段来源归属。
- StateStore 创建任何文件前必须确认状态目录不位于 Git worktree 内；该边界覆盖默认目录、
  `--state-dir`、demo、once 与安装路径，禁止真实主题/session/脉络进入仓库工作树。
- 已关闭判断不能原地复活；新证据必须生长新方向并保留修订关系。
- 一个 transcript offset 至多消费一次；提交状态必须原子替换。
- 每个可验证 summary hint 版本至多处理一次；hint 游标与 transcript offset 同属 provider +
  session 的消费状态。Roll token 只累计 CLI 结构化输出明确报告的数值，未报告调用单独计数，
  不进行估算或价格换算。
- `intake.phase`、coverage、imported 逻辑 session 与 history job 同住 `state.json`；浏览器不
  持有导入事实。History item 的 cursor 与 live offset 分离，两者都只能单调前进；history
  item 的 `retryCount` / `retryAt` 和 job 的 `lastProgressAt` 是耐久恢复与停滞解释依据，UI
  阶段仍是 watcher 的瞬时投影，重启后不得把旧 `rolling` 状态当作事实。
- 真正空的新状态进入 `awaiting-choice`；缺少 intake 字段但已有 roots、nodes、sessions 或
  offsets 的旧状态修复为 `complete`，不得改变既有 offset 或触发历史任务。
- Session 的 `firstSeenAt` 只在首次创建时写入，后续活动不得改写；旧状态缺失该字段时
  以已有 `lastTranscriptAt` 修复并持久化，不改变 session 对象、归属或 offset。
- runtime 只校验 ID、schema、边界和副作用，不自行猜测语义。
- 状态修复只产生归一化后的内存对象；只有 StateStore 可以把它持久化。InstanceLock 只保护
  唯一 runtime 生命周期，不成为第二个状态或写入协议。

## 验证

主要覆盖在 `tests/state-tree.test.ts`、`tests/migration.test.ts` 和
`tests/adapters-roll.test.ts`。任何 schema 或树写入改动必须运行 `bun run check`。
