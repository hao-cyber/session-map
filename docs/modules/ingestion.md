# 采集与滚动模块

## 职责

通过 provider registry 只读发现 Claude、Codex、Kimi、Grok 与可恢复 MiniMax CLI 的
session source，按持久消费位置读取有界片段，并把模型输出交给状态写边界。Orca 只提供
增强信息，不是采集或恢复的前置条件。

## 代码入口

- `src/monitor.ts`：transcript 发现、进程与 session 关联。
- `src/watcher.ts`：监听、去抖和串行调度。
- `src/adapters.ts`：不同 transcript 格式的只读适配。
- `src/providers.ts`：provider 的发现目录、source 形态、身份与恢复协议注册表。
- `src/roll.ts`：有界模型输入、输出解析与 rolling snapshot。

## 不变量

- transcript 永远只读；不得为标记消费状态而修改来源文件。
- 完整 transcript / event log 才是采集来源。Memory、prompt history、session index 与摘要
  不能独立驱动树生长，只能补充 cwd、title 等可验证元数据。
- offset 只随成功提交前进，失败可重试但不得重复 grow。
- Append-only source 按 byte offset 消费；原子重写的 snapshot source 按 mtime 消费整个
  有界快照。两类 source 均须在应用非幂等 op 前持久提交消费位置。
- 输入按字节、消息数和处理时长设硬边界。
- 初始命令行没有 session ID 时，关联必须依赖可验证的打开文件、PID、TTY 等证据。
- 模型不可用或输出无效时保留既有地图，不伪造语义更新。
- 当前注册 provider：Claude Code `~/.claude/projects/*/*.jsonl`、Codex
  `$CODEX_HOME/sessions/**/rollout-*.jsonl`、Kimi `$KIMI_SHARE_DIR/sessions/*/*/context.jsonl`、
  Grok `$GROK_HOME/sessions/*/*/updates.jsonl`，以及提供 `minimax --resume` 的社区 MiniMax
  CLI `~/.minimax/sessions/*.json`。官方 `mmx` 是多模态 API CLI，没有持久可恢复 agent
  session，因此不作为 session provider。

## 验证

主要覆盖在 `tests/monitor.test.ts`、`tests/watcher.test.ts` 和
`tests/adapters-roll.test.ts`。重启验收还应比较节点 ID 集合与 offsets，确认没有重复生长。
