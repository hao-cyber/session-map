# 采集与滚动模块

## 职责

通过 provider registry 只读发现 Claude、Codex、Kimi、Grok 与可恢复 MiniMax CLI 的
session source，按持久消费位置读取有界片段，并把模型输出交给状态写边界。能够与准确
session 身份绑定的 provider memory summary 可作为可丢弃的辅助语义输入；Orca 只提供
增强信息。两者都不是采集或恢复的前置条件。

## 代码入口

- `packages/core/src/monitor.ts`：transcript 发现、进程与 session 关联。
- `packages/core/src/watcher.ts`：metadata inventory、首次 baseline、历史任务、监听去抖、keyed worker 与串行提交闸门。
- `packages/core/src/adapters.ts`：不同 transcript 格式的只读适配。
- `packages/core/src/providers.ts`：provider 的发现目录、source 形态、身份与恢复协议注册表。
- `packages/core/src/roll.ts`：有界 prompt、模型 JSON 协议、输出校验与 rolling snapshot；
  不探测或启动外部程序。
- `packages/core/src/roll-engine.ts`：模型 CLI 的安装/登录探测、调用计划、超时、失败冷却和
  进程执行；只返回经 `roll.ts` 协议校验的候选输出。

## 不变量

- transcript 永远只读；不得为标记消费状态而修改来源文件。
- 用户显式删除的 provider + session 身份必须从 inventory 计数、历史选择、live 排队和提交中
  排除；在途结果提交前再次检查，不能因 transcript 仍存在或继续增长而复活记录。
- 完整 transcript / event log 才是 session 的发现与恢复来源。Memory、prompt history、
  session index 与摘要不能独立创建 session，也不能独立驱动主题迁移或树生长。
- Provider memory summary 只有在 registry/adapter 能把它绑定到准确的 provider + session
  身份并判断新鲜度时，才可作为非权威的 roll hint。它可以帮助模型修订 session rolling
  snapshot 的整体主标题、最新进展与有界因果路标，并为既有主题匹配提供候选；它不得直接
  写状态。无法验证身份、来源或新鲜度时忽略；与 transcript 或持久轨迹冲突时以后两者为准。
- Token 成本是一等运行约束。常态 roll 只发送有界新增 transcript、上一版 snapshot、当前
  主题子树和少量主题候选；不得周期性重读完整 transcript。只有低置信、候选冲突、新旧摘要
  矛盾或显式重审时才有界扩大证据窗口，并继续服从字节、消息数、调用频率和超时上限。
- offset 只随成功提交前进，失败可重试但不得重复 grow。
- 首次选择前只发现 provider、逻辑 session、mtime 和大小，不读取正文、不调用 roll。
  用户确认时对全部已发现 source 建立 live 高水位；“不导入历史”也必须写入该 baseline。
- 历史范围按 source 最后活跃时间选择完整 session。7/30/90 天和自定义起始日只决定候选
  集合；结束边界固定为确认时的 source 大小/版本。以后扩大范围只导入未标记 imported 的
  逻辑 session，不回放已完成项。
- History item 使用独立 cursor，单个 session 内按原始顺序有界滚动；未追到 high-water 前
  阻塞同 source 的 live 队列。瞬时单项失败使用有界指数退避且不阻塞其他 session；引擎未登录
  等全局失败立即暂停，单项耗尽三次尝试后只在其他可运行项收口时进入 paused。重启或显式继续
  都从已提交 cursor 恢复。取消保留已生成地图和 imported 记录，不回滚树。
- Roll 候选按 provider + logical session id 加顺序门禁：同 session 严格串行，不同 session
  最多三个并行；history 最多占两个槽，给 live 保留一个槽。优先级固定为新 session 首次
  出现、已有 session 实时更新、历史回填；同级保持 FIFO，但不强杀已经在途的模型进程。
- 并行 worker 只读 transcript 和树投影，不直接写树。cursor/history 提交与
  `TreeRuntime.applyRoll` 经过单一串行 commit gate；gate 只做游标检查、候选新鲜度校验和原子
  写入，不等待模型。source root、目标 root 或新主线目录发生变化时，先释放 gate，再基于最新
  状态有界重算并重新竞争提交。完整协议与回滚见
  [ADR 0014](../decisions/0014-short-commit-gate-and-priority-lanes.md)。
- “立即检查”执行一次全量 metadata discovery 和当前增量 poll；它不重置 offset、history
  cursor 或 coverage，也不替代后台持续轮询。常态 live 仍只调度最近活跃的 60 个 source。
- 全新发现且尚无 live offset 的 session 立即进入首次语义 roll；已经建立入口的 session
  仍使用有界 linger 合并成批写入，避免首次入口在固定等待之后才开始承担模型延迟。
- Append-only source 按 byte offset 消费；原子重写的 snapshot source 按 mtime 消费整个
  有界快照。两类 source 均须在应用非幂等 op 前持久提交消费位置。
- 输入按字节、消息数和处理时长设硬边界。
- 初始命令行没有 session ID 时，关联必须依赖可验证的打开文件、PID、TTY 等证据。
- 模型不可用或输出无效时保留既有地图，不伪造语义更新。
- 模型协议不依赖具体 CLI；外部引擎执行只能通过 roll-engine 接入，且不能绕过 roll 的
  有界输入和输出校验。roll-engine 无持久业务状态，失败冷却只影响可用性投影。
- 正式服务日志为每次外部 roll 记录 engine、mode、attempt、provider、session id、开始与完成
  时长；`attempt=stale-retry` 表示候选因语义投影变化而重算。失败记录同一身份和总耗时，
  不写 transcript 正文、prompt、模型输出或 transcript 绝对路径。
- Roll engine 优先使用结构化输出并提取 CLI 明确报告的 input/output/total token usage；每次
  已完成调用（包括 stale retry）的精确 usage 由同一状态写入协议累计。CLI 未报告时只累计
  unreported 次数，不按字符或字节估算 token，也不推导金额。
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
失败隔离与续跑、snapshot 不重复消费、手动检查不改变 coverage、不同 session 的有界并行、
三级优先级、live 保留槽、短 commit gate 与 stale candidate 重算。Provider summary 接入还须
验证身份与新鲜度绑定、常态 prompt 预算、无 transcript 证据时不迁移主题/不修改永久脉络、
summary 与 transcript 冲突时 transcript 胜出，以及 summary 缺失或损坏时无损退化。
Usage 验证还须覆盖结构化 wrapper/JSONL、未报告降级、stale retry 计量和重启后的累计值。
