# 采集与滚动模块

## 职责

只读发现 Claude、Codex 等 transcript，按持久 offset 增量读取有界片段，并把模型输出
交给状态写边界。Orca 只提供增强信息，不是采集或恢复的前置条件。

## 代码入口

- `src/monitor.ts`：transcript 发现、进程与 session 关联。
- `src/watcher.ts`：监听、去抖和串行调度。
- `src/adapters.ts`：不同 transcript 格式的只读适配。
- `src/roll.ts`：有界模型输入、输出解析与 rolling snapshot。

## 不变量

- transcript 永远只读；不得为标记消费状态而修改来源文件。
- offset 只随成功提交前进，失败可重试但不得重复 grow。
- 输入按字节、消息数和处理时长设硬边界。
- 初始命令行没有 session ID 时，关联必须依赖可验证的打开文件、PID、TTY 等证据。
- 模型不可用或输出无效时保留既有地图，不伪造语义更新。

## 验证

主要覆盖在 `tests/monitor.test.ts`、`tests/watcher.test.ts` 和
`tests/adapters-roll.test.ts`。重启验收还应比较节点 ID 集合与 offsets，确认没有重复生长。
