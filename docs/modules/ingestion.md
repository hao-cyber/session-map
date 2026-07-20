# 采集与滚动模块

## 职责

通过 provider registry 只读发现 Claude、Codex、Kimi、Grok 与可恢复 MiniMax CLI 的
session source，按持久消费位置读取有界片段，并把模型输出交给状态写边界。Orca 只提供
增强信息，不是采集或恢复的前置条件。

## 代码入口

- `src/monitor.ts`：transcript 发现、进程与 session 关联。
- `src/watcher.ts`：metadata inventory、首次 baseline、历史任务、监听去抖、keyed worker 与串行提交闸门。
- `src/adapters.ts`：不同 transcript 格式的只读适配。
- `src/providers.ts`：provider 的发现目录、source 形态、身份与恢复协议注册表。
- `src/roll.ts`：有界模型输入、输出解析与 rolling snapshot。

## 不变量

- transcript 永远只读；不得为标记消费状态而修改来源文件。
- 用户显式删除的 provider + session 身份必须从 inventory 计数、历史选择、live 排队和提交中
  排除；在途结果提交前再次检查，不能因 transcript 仍存在或继续增长而复活记录。
- 完整 transcript / event log 才是采集来源。Memory、prompt history、session index 与摘要
  不能独立驱动树生长，只能补充 cwd、title 等可验证元数据。
- offset 只随成功提交前进，失败可重试但不得重复 grow。
- 首次选择前只发现 provider、逻辑 session、mtime 和大小，不读取正文、不调用 roll。
  用户确认时对全部已发现 source 建立 live 高水位；“不导入历史”也必须写入该 baseline。
- 历史范围按 source 最后活跃时间选择完整 session。7/30/90 天和自定义起始日只决定候选
  集合；结束边界固定为确认时的 source 大小/版本。以后扩大范围只导入未标记 imported 的
  逻辑 session，不回放已完成项。
- History item 使用独立 cursor，单个 session 内按原始顺序有界滚动；未追到 high-water 前
  阻塞同 source 的 live 队列。失败把 job 置为 paused，重启或显式继续从已提交 cursor 恢复。
  取消保留已生成地图和 imported 记录，不回滚树。
- Roll 候选按 provider + logical session id 加顺序门禁：同 session 严格串行，不同 session
  最多三个并行；history 最多占两个槽，给 live 保留一个槽。队列把 live 排在 history 前，
  但不强杀已经在途的模型进程。
- 并行 worker 只读 transcript 和树投影，不直接写树。cursor/history 提交与
  `TreeRuntime.applyRoll` 经过单一串行 commit gate；source root、目标 root 或新主线目录相对
  分析时发生语义变化，候选必须在 gate 内用最新状态重算。完整协议与回滚见
  [ADR 0008](../decisions/0008-bounded-parallel-rolls.md)。
- “立即检查”执行一次全量 metadata discovery 和当前增量 poll；它不重置 offset、history
  cursor 或 coverage，也不替代后台持续轮询。常态 live 仍只调度最近活跃的 60 个 source。
- Append-only source 按 byte offset 消费；原子重写的 snapshot source 按 mtime 消费整个
  有界快照。两类 source 均须在应用非幂等 op 前持久提交消费位置。
- 输入按字节、消息数和处理时长设硬边界。
- 初始命令行没有 session ID 时，关联必须依赖可验证的打开文件、PID、TTY 等证据。
- 模型不可用或输出无效时保留既有地图，不伪造语义更新。
- 正式服务日志为每次外部 roll 记录 engine、mode、attempt、provider、session id、开始与完成
  时长；`attempt=stale-retry` 表示候选因语义投影变化而重算。失败记录同一身份和总耗时，
  不写 transcript 正文、prompt、模型输出或 transcript 绝对路径。
- 历史任务创建前必须确认当前 Roll 引擎已安装且已登录；不可用时拒绝启动，不得先落一个
  注定失败的 job。单次失败进入冷却，内部队列续调度不得用 force 绕过冷却反复刷日志。
- 当前注册 provider：Claude Code `~/.claude/projects/*/*.jsonl`、Codex
  `$CODEX_HOME/sessions/**/rollout-*.jsonl`、Kimi `$KIMI_SHARE_DIR/sessions/*/*/context.jsonl`、
  Grok `$GROK_HOME/sessions/*/*/updates.jsonl`，以及提供 `minimax --resume` 的社区 MiniMax
  CLI `~/.minimax/sessions/*.json`。官方 `mmx` 是多模态 API CLI，没有持久可恢复 agent
  session，因此不作为 session provider。
- Monitor 还按 session 的持久 `cwd` 只读 Git，投影当前 worktree 根、branch、dirty 与
  ahead；该投影不写入 `state.json`，不参与 session 归属、排序或恢复决策，重启后重采。

## 验证

主要覆盖在 `tests/monitor.test.ts`、`tests/watcher.test.ts` 和
`tests/adapters-roll.test.ts`。重启验收还应比较节点 ID 集合与 offsets，确认没有重复生长。
首次摄取还须验证确认前零模型调用、skip baseline、范围扩展不重复、固定 history 边界、
失败续跑、snapshot 不重复消费、手动检查不改变 coverage、不同 session 的有界并行、live
保留槽与 stale candidate 重算。
