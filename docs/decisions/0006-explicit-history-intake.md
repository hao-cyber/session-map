# ADR 0006：显式首次摄取与可扩展历史导入

> 状态：已采纳
> 日期：2026-07-20

## 背景与约束

旧 watcher 在空状态中会直接消费最近活跃的 transcript。用户无法知道安装会读取多少历史、
调用多少次模型，也不能区分持续监听与一次性回扫。单一向前 offset 还无法安全表达“先导入
30 天，以后扩到 90 天”：若回退 offset 会重复非幂等 grow，若不回退则不能补旧背景。

设计必须继续满足 transcript 只读、单状态文件、单写者、at-most-once、有界模型输入、
对象恒存和回环同源安全；旧安装升级不得被当成新用户。

## 决策

- 真正空的新状态进入 `awaiting-choice`，确认前只做全量 metadata inventory。
- 用户选择 7/30/90 天、自定义起始日或不导入历史。范围按最后活跃时间选中完整逻辑 session。
- 首次确认原子把全部已发现 source 的 live offset 设到 high-water。命中范围的 source 同时
  获得独立耐久 history item，从头追到确认时固定的大小/版本。
- History cursor 与 live offset 分离，均先于非幂等树操作提交。同 source 的 history 完成前
  阻塞 live；不同 source 可以继续。后续并行调度与 stale candidate 提交协议由
  [ADR 0008](0008-bounded-parallel-rolls.md) 收紧。失败暂停，继续和重启从耐久 cursor 恢复；
  取消不删除已形成的树。
- `imported` 以 provider + logical session id 去重。以后“补扫历史”只向更早 coverage 扩展，
  不重跑已完成 session。
- “立即检查”只做 discovery + 当前 poll，不改变 coverage、offset 或已导入集合。后台轮询
  始终是常态机制。

## 所有权与数据流

```text
provider metadata ─► watcher/coordinator ─► intake plan + live baseline
provider transcript ─► bounded adapter ─► history/live cursor commit ─► TreeRuntime
state.json ─► /api/snapshot ─► 同一 Web 文档
同源用户动作 ─► /api/intake/* ─► watcher/coordinator
```

Transcript 是只读事实源；`state.json` 是 intake、cursor、树和 session 的唯一耐久事实源；
watcher/coordinator 是计划与消费位置的写入者；TreeRuntime 仍是语义树写边界；Web 只展示
投影并发出明确动作。

## 失败、重启、安全与回滚

- 固定 high-water 防止导入期间新增内容混入历史；history 追平后 live 再处理新增部分。
- cursor-before-apply 保留原有 at-most-once 取舍：极窄崩溃窗口可少一次更新，不会重复 grow。
- 模型或解析失败把当前 item 标记 failed 并暂停 job，不推进 cursor；恢复后安全重试。
- Inventory API 不返回 transcript 正文；写动作继续要求回环同源、严格 JSON 和体积上限。
- 旧 schema 缺少 intake 且已有耐久对象时修复为 complete，offset 原样保留。回滚到忽略未知
  字段的旧 binary 时，live baseline 仍由旧版认识的 offsets 保护；进行中的 history job 应
  在降级前暂停，已形成的树无需撤销。

## 备选方案

- **继续自动扫最近 60 个 session**：最快出现内容，但没有知情选择，成本和覆盖均不可见。
- **只增加一个时间字段并复用 live offset**：界面有选择，数据模型仍会漏扫或重复 grow。
- **默认导入所有历史**：覆盖最完整，但首次价值慢、模型成本不可预测、选择压力最高。
- **把导入计划放在浏览器存储**：换浏览器会重复引导，且无法保护后台 offset 与重启恢复。

## 验证证据

- Watcher 测试覆盖确认前零调用、skip high-water、30→90 天只扩不重、模型失败续跑。
- Adapter 测试覆盖固定历史边界和无换行末行；snapshot 完成时同步 live 版本避免重复消费。
- 状态测试覆盖空安装 awaiting-choice 与旧 schema complete 修复。
- HTTP 测试覆盖 snapshot intake 投影、立即检查和 skip API 的同源写入。
- 代表性桌面截图检查范围决策、导入进度、工具栏低显著入口与响应式溢出。

## 后果

首次体验多了一个明确决策，但用户获得了范围、成本和撤回控制；持续监听与历史导入的心智
模型也变得可解释。状态 schema 增加 intake job 与双游标，换来范围扩展、失败恢复和升级不
回扫的可推导行为。30 天推荐仍需通过真实 inventory 与首条工作线耗时校准。
