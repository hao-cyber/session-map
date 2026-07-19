# 状态模型模块

## 职责

维护工作主线、session、因果脉络、归档、offset 和 rolling snapshot 的唯一持久状态。
本模块实现“不可抹除的思考轨迹 + 可修订的当前快照”，但不替模型决定语义。

## 代码入口

- `src/types.ts`：持久 schema 与运行时类型。
- `src/state.ts`：单写者、原子替换、revision 与状态加载。
- `src/tree.ts`：节点生长、修订、关闭、归档和撤销边界。
- `src/constants.ts`：schema 与有界输入常量。

## 不变量

- 一级对象始终是工作主线；session 是其来源与恢复入口。
- 节点只能追加、修订、衰减或归档，不能静默消失。
- 已关闭判断不能原地复活；新证据必须生长新方向并保留修订关系。
- 一个 transcript offset 至多消费一次；提交状态必须原子替换。
- Session 的 `firstSeenAt` 只在首次创建时写入，后续活动不得改写；旧状态缺失该字段时
  以已有 `lastTranscriptAt` 修复并持久化，不改变 session 对象、归属或 offset。
- runtime 只校验 ID、schema、边界和副作用，不自行猜测语义。

## 验证

主要覆盖在 `tests/state-tree.test.ts`、`tests/migration.test.ts` 和
`tests/adapters-roll.test.ts`。任何 schema 或树写入改动必须运行 `bun run check`。
