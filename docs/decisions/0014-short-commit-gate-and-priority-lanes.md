# ADR 0014：短提交闸门、三级优先队列与历史失败隔离

> 状态：已采纳
> 日期：2026-07-21
> 替代：[ADR 0008](0008-bounded-parallel-rolls.md) 中“在 commit gate 内重算”和“任一 history
> 失败立即暂停整个 job”的部分决策

## 背景与约束

ADR 0008 把独立 session 的模型调用并行化，同时保留单写者提交。但过期候选会持有全局
commit gate 等待一次最长 180 秒的模型重算；任一历史项失败也会立即暂停全部回填。两者都会
把局部慢调用扩大为全局不可见进度。新 session 与普通 live 更新使用同一优先级，也无法保证
首次入口先于已有入口的批量更新。

必须继续保持同 session 有序、history 不占满 live 容量、offset-before-apply、模型输出不可信、
`TreeRuntime` 唯一写树和单文件原子替换。

## 决策

- 队列使用三个固定 lane：`live-new`、`live-update`、`history`，按此顺序调度，同级 FIFO。
- 总 roll 并发仍为三，history 上限仍为二；在途模型调用非抢占。
- commit gate 只执行游标/job 身份复核、候选依赖新鲜度校验和原子提交。候选过期时立即释放
  gate，在外部基于最新快照重算，最多连续三次；仍不稳定则按该工作项失败处理。
- history 瞬时单项错误最多尝试三次，使用 5 秒起步的指数退避；等待期间其他 session 继续。
  引擎不可用或未登录属于全局失败，立即暂停。单项耗尽尝试后标记 failed，但只在其他可运行
  项收口后把 job 置为 paused。
- `retryCount`、`retryAt` 与 `lastProgressAt` 持久化；queued/reading/rolling/validating/committing
  是 watcher 运行态投影，不写入状态，避免重启后展示伪在途任务。

## 数据流与所有权

```text
live-new ─┐
live-update ─► keyed bounded workers ─► candidate ─► short commit gate ─► TreeRuntime
history ──┘                                  │ stale
                                            └──── release ─► bounded re-roll
```

并发范围仍限于只读解析和外部模型进程。Watcher 拥有队列、history cursor 与 live offset；
`TreeRuntime` 仍是树写入唯一入口；Web 只读取阶段投影和耐久进度。

## 失败、迁移与回滚

- schema 5 状态加载为 schema 6 时，为旧 history job 用创建时间修复 `lastProgressAt`；缺失的
  retry 字段等价于从未重试，不触发回放。
- 进程退出会丢失瞬时 stage，但 cursor、retry 和 job 状态保留；重启重新排队。
- 回滚旧版本会忽略新增可选字段，既有 cursor 与树仍可读取。
- 若模型 CLI 不支持当前并发，仍可把总并发或 history 上限降为一，不改变提交协议。

## 验证

- 测试证明新 session 在已知 live 更新之前获得空闲槽。
- 测试证明 stale 重算阻塞时，另一个候选仍可完成提交。
- 测试证明单个历史 session 瞬时失败不阻塞其他 session，并可从原 cursor 重试。
- 既有测试继续证明 history 上限、live 保留槽、同 session 顺序、取消晚到结果和 at-most-once。
