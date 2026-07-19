# ADR 0002：以 provider adapter 统一多 CLI session 发现与恢复

## 状态

Accepted — 2026-07-20

## 背景与约束

SessionMap 需要自动发现不同 coding-agent CLI 的 session，并把“回到终端 / 恢复”作为
核心入口。各 CLI 的持久化并不相同：有 append-only JSONL、ACP event log，也有原子重写
的 JSON snapshot；memory、输入历史和索引又常与完整会话并存。直接扫描所有 JSON/JSONL
会重复采集、误把摘要当 transcript，并可能生成无法恢复的入口。

必须继续满足：来源只读、单写者、at-most-once 生长、有界读取、provider + session 身份
验证、原 cwd 恢复和回环 capability 安全。最多处理最近活跃的 60 个逻辑 session，防止
provider 增长把后台工作量变成无界扫描。

## 决策

建立显式 provider registry。每个 adapter 独占以下事实：

- 标准 home、环境变量覆盖、source 路径与 source 形态；
- session ID、cwd、title 的提取方式；
- 对话、工具名和错误的安全过滤；
- 进程名、打开 source 的身份识别与原生 resume 命令。

Watcher 只编排发现、冷却、消费提交和串行 roll，不包含 provider 格式分支。Append-only
source 用 byte offset；snapshot source 用 mtime 作为版本并每次有界读取完整 JSON。
Memory、prompt history、索引和 summary 只能补充元数据，不能独立成为树生长来源。

当前支持 Claude Code、Codex、Kimi、Grok，以及公开实现了 `~/.minimax/sessions/*.json`
和 `minimax --resume` 的社区 MiniMax CLI。MiniMax 官方 `mmx` 当前不保存可恢复 agent
session，因此明确不映射成虚假 provider。

动作层先验证缓存 handle / PID；缓存失效后并行刷新证据；最后才生成原生恢复命令。
Provider 未提供可靠恢复协议、cwd 不存在或身份有歧义时明确失败。

## 备选方案与取舍

1. 扫描 memory 文件：体积小，但缺少完整消息、工具错误和可靠恢复身份，拒绝。
2. 调用各 CLI 的 session list 命令：输出适合人读、版本变化大且轮询成本高；仅可作为
   未来补充探测，不作为事实源。
3. 把每个 CLI 做成独立 watcher / 状态文件：会破坏单写者与统一状态模型，拒绝。
4. 只支持 JSONL：实现简单，但无法正确消费原子重写 snapshot；采用双 source 语义。

## 后果、迁移与回滚

Provider 枚举会扩展，但持久 session 结构不复制；旧 Claude / Codex 状态原样加载。
新增 provider 可通过删除对应 adapter 注册回滚，既有树节点与 session 入口继续恒存，
不会修改或删除来源文件。验证必须覆盖 fixture、真实本机 discovery、快速 PID 路径、
每种 resume 命令、重启后 offset/mtime 不重复生长，以及 standalone 服务冒烟。
