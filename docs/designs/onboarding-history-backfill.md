# 首次使用与历史回扫设计

> 状态：已采纳并实现。长期契约已进入产品宪章和模块文档；架构取舍见
> [`../decisions/0006-explicit-history-intake.md`](../decisions/0006-explicit-history-intake.md)。
>
> 交互原型：[`../prototypes/sessionmap-onboarding-history-v1.html`](../prototypes/sessionmap-onboarding-history-v1.html)
>
> 本提案服从 [`../product-design.md`](../product-design.md) 的产品本体、三秒恢复契约、
> 单写者、对象恒存与本地信任边界。

## 1. 结论

新安装后应当允许用户回扫已有 agent session，并让用户设置“回溯到多早”。但它不能被
设计成一个安装向导里的普通时间范围字段，也不能继续像当前实现一样静默处理最近 60 个
session。

首次体验应分成两个明确概念：

- **从现在开始持续整理**：安装成功后持续监听新 transcript，不受历史范围影响。
- **把近期工作带进地图**：一次可预览、可暂停、可续扫、可向更早扩展的历史导入。

推荐默认值的产品假设是“最近 30 天活跃过的 session”。界面先只展示 `7 天 / 30 天（推荐） /
90 天 / 自定义` 四个可识别选项和一个“不导入历史”的次级动作。自定义只要求用户选择
“回溯到哪一天”，结束时间固定为安装确认时刻，避免无意义的双日期决策。

时间范围选择的是 **在范围内活跃过的完整 session**，不是从 transcript 中间硬切一段。
例如，一个两个月前创建、昨天仍有活动的 session 会被完整回扫。这样更符合用户对
“把这条工作带回来”的心理模型，也避免从半句话开始生成错误脉络。

## 2. 当前行为与问题

当前 `discoverTranscripts()` 按 mtime 取最近 60 个逻辑 session。新状态中没有 offset 时，
watcher 会自动把这些 source 加入队列；append source 超过读取上限时只从最后 4 MiB 开始。
页面空状态只显示“等待 Claude Code / Codex 产生第一条结构变化”。

这会产生五个问题：

1. **心理模型不透明**：用户不知道 SessionMap 正在读旧数据，还是只等待未来数据。
2. **控制感缺失**：无法预览来源、数量、时间和潜在模型调用量，也无法跳过。
3. **完成感缺失**：长队列没有进度；第一条地图出现前，空状态像故障。
4. **语义承诺过度**：尾部读取可能找回“现在怎样”，却不能诚实宣称恢复了完整历史。
5. **机制不支持扩展范围**：单一向前 offset 不能安全表达先扫 30 天、以后扩到 90 天。

## 3. 认知心理学裁决

### 3.1 先建立概念模型，再要求选择

Norman 的 Conceptual Model 与 Mapping 要求控件直接对应系统行为。首屏只解释三件事：

1. SessionMap 只读发现本机可恢复的 agent session；
2. 新对话会从现在起持续整理；
3. 用户可以选择是否把旧 session 带进地图。

不得用“索引窗口”“offset”“全量扫描”等实现词。时间选项使用“最近 30 天活跃过的
session”，并紧邻显示“18 个 session · 约 6 分钟”，让范围与结果形成自然映射。

### 3.2 识别优于回忆，默认值替用户降低决策成本

工作记忆的实际处理上限约为 2–4 个 chunk。首屏保留三个信息块：产品承诺、发现结果、
主动作。范围只提供四个可见选项，不要求用户凭空输入日期。30 天作为推荐默认值，但必须
允许一键改选或跳过；默认服务于用户找回近期工作的利益，不服务于扩大模型调用量。

### 3.3 让用户用真实数据完成一次有意义的动作

IKEA effect 与 generation effect 都提示：完全被动的自动导入不利于形成归属感，但要求
用户手工新建主题又会制造第二事实源。最小的主动投入应是“确认回扫范围”，随后让系统用
用户自己的 session 生成第一条真实工作线。它既建立控制感，又不让用户维护语义结构。

### 3.4 反馈必须原位、连续、可退出

长操作需要可见进度。确认后，同一内容区从选择态变成构建态，不弹第二个 modal：

- 400ms 内显示“正在读取第 1/18 个 session”；
- 每完成一个 session 就更新完成数、当前并行路数和一个代表性在途来源；
- 第一条工作线形成后立即在下方真实目录中出现；
- 用户可以“先看地图”，导入继续在后台；
- 暂停、失败和重试都留在原进度对象上，不只依赖 toast。

关键反馈出现后至少 800ms 再呈现下一条引导，避免 attentional blink。进度列表保持稳定，
不得因新结果不断重排，符合 inhibition of return 与产品的空间连续性要求。

### 3.5 不用完成率和损失文案操纵用户

不使用“还差一步”“不要丢失你的历史”或虚假倒计时。跳过历史不会降低持续监听能力；
用户以后可从工具栏的“补扫历史”再次进入。伦理评估为绿灯：默认可见、用途明确、可撤回、
不扩大读取范围、不制造数据损失恐惧。

## 4. 首次体验流程

### 4.1 状态 A：本地发现

服务启动后先做纯本地 metadata discovery，不调用 roll engine、不创建工作主线、不读取
transcript 正文。空地图内显示一个与目录同宽的引导对象：

```text
把最近的工作带进 SessionMap
已在本机发现 Claude Code 12 · Codex 6 · Kimi 0

[最近 7 天  6 个] [最近 30 天 18 个 · 推荐] [最近 90 天 31 个] [自定义]

只读这些 session 的完整对话，用当前 roll 引擎整理成工作线。
[开始整理 18 个 session]     不导入历史
```

如果没有发现历史 session，跳过范围选择，显示“已准备好，从下一条 agent 对话开始整理”，
并提供“打开使用说明”；不得展示示例主题或伪造成功数据。

如果没有可用 roll engine，仍显示发现数量，但主动作改为“先完成引擎登录”，并给出具体
provider 状态。用户可以选择“不导入历史”，进入真实空地图。

### 4.2 状态 B：范围确认

默认展示 30 天。每次改选都只重算本地 inventory，立即更新：

- 命中的逻辑 session 数；
- provider 分布；
- 待读取字节量与模型调用的区间估计；
- 说明“包含这些 session 的完整对话”；
- 说明“以后可以继续向更早扩展，不会删除或重做已完成部分”。

“自定义”展开一个起始日期字段和同样的结果预览。provider、目录、仓库筛选属于高级
披露，不进入首次默认流程；若未来真实用户数据证明范围仍过大，再加入“调整来源”。

发现结果旁提供低显著度的“重新检查”。它只重新执行本地 metadata discovery，用于用户
刚结束一个 session、刚安装新 provider，或怀疑结果过期时确认系统状态；它不读取正文、
不调用模型、不清 offset，也不开始历史导入。触发后原位显示“检查中…”与新的检查时间。

### 4.3 状态 C：增量形成地图

确认动作创建一个耐久 import job，并立即把进度退到状态行，让用户进入真实地图；“历史进度”
可随时重新展开同一个耐久对象：

```text
正在把近期工作整理成地图                         7 / 18
2 路并行 · 当前：Codex · sessionmap · 设计首次导入
完成的工作线已立即出现在下方目录
[暂停] [先看地图]
```

真实目录随 job 推进逐步出现。进度卡不占住主阅读面；关闭页面、服务重启或更换浏览器后，
从同一耐久 job 继续，不重新消费完成的范围。百分比只表达已提交 session 数，不承诺线性 ETA。

### 4.4 状态 D：完成与首次价值

完成时只给一个简短结果：

```text
近期工作已带回来
18 个 session → 7 条工作线，其中 2 条正在等你处理
[查看最需要处理的工作线]
```

主动作直接滚动到第一个 decision/reply/review/blocker；如果没有待处理项，则定位最近活跃
的工作线。这个结尾直接兑现三秒恢复契约，而不是庆祝“扫描了多少数据”。

完成卡在用户第一次明确进入地图后收起。以后只在工具栏的低显著入口显示“补扫历史”；
不要把 onboarding 永久占据首页。

## 5. “补扫历史”后的规则

- 用户可以把 30 天扩到 90 天或自定义更早日期；只能扩展覆盖范围，不能用缩短范围删除对象。
- 已成功导入的 session 以稳定 provider + session ID 识别，不重复生成树节点。
- 新发现但时间更早的 session 进入同一个单写者导入协议。
- “暂停”只停止后续模型调用，不回滚已形成的不可抹除轨迹。
- “取消剩余导入”保留已完成结果，并把未开始/未完成项标为 skipped；以后可继续。
- 用户选择“不导入历史”时，为当时已发现 source 原子写入 baseline 高水位；这些 source
  之后的新内容仍会被正常采集，旧内容不会在下次重启时被静默补扫。

## 6. 自动运行与手动“立即检查”

SessionMap 的默认承诺仍是一直运行，不能依赖用户反复刷新。手动入口是恢复控制和诊断
新鲜度的 escape hatch，不是日常工作流：

- 正常地图的“更新于 … / 服务健康”可展开状态详情，其中提供“立即检查”。
- “立即检查”要求 watcher 立刻做一次 discovery + poll，并返回发现、排队、处理中或错误；
  已消费 source 仍按 offset 跳过，不能重新 grow。
- 页面只重新读取同一服务端 snapshot；浏览器刷新不是采集机制，也不能重建业务状态。
- 正常健康时入口保持低显著；超过两个正常 poll 周期仍无新鲜度更新、provider source
  不可读或 roll 失败时，才把“立即检查/重试”提升到原位可见动作。
- “立即检查”只检查当前持续监听范围；要把 coverage 扩到更早日期必须进入“补扫历史”。

文案用“立即检查”而不是“刷新”，避免把页面重绘、source 发现、历史扩展和模型重跑混成
一个不可预测动作。

## 7. 轻量架构审查

### 7.1 受影响契约

- `ingestion`：发现与消费之间增加 inventory、import plan 和 baseline 三个显式阶段。
- `state-model`：同一 `state.json` 增加耐久 onboarding/import job；不创建第二状态文件。
- `web-ui`：真实空状态升级为首次导入流程；正常地图仍保持主题 → session → 脉络。
- `local-runtime`：服务重启恢复 job；浏览器仅投影和发起同源动作。
- `migration-release`：旧安装升级不得触发 onboarding 或重新回扫；只有真正空的新状态进入。

### 7.2 唯一事实源与写入者

Transcript 仍是只读事实源。`state.json` 仍是树、session、offset 与 import job 的唯一耐久
事实源。Watcher/ingestion coordinator 是消费计划的唯一写入者，TreeRuntime 仍是语义树
写边界。浏览器不能直接改 offset、session 或节点。

### 7.3 建议状态模型

```ts
interface IntakeState {
  phase: "awaiting-choice" | "importing" | "complete";
  coverageStartAt: string | null;
  lastDiscoveryAt: string | null;
  imported: Record<string, string>;
  job: HistoryImportJob | null;
}

interface HistoryImportJob {
  id: string;
  createdAt: string;
  cutoffAt: string;
  highWaterAt: string;
  status: "running" | "paused" | "complete" | "cancelled";
  items: Record<string, {
    provider: Provider;
    sessionId: string;
    path: string;
    kind: "append" | "snapshot";
    plannedSize: number;
    plannedMtimeMs: number;
    cursor: number;
    status: "pending" | "running" | "complete" | "skipped" | "failed";
    reconcile: boolean;
    error?: string;
  }>;
}
```

`items` 是消费账本，不是第二套 session 模型。稳定 key 使用 provider + 原生 session ID；
path 只用于定位 source。完成后可以把详细 item 压缩为 coverage 与完成 ID 集合，但删除前
必须证明扩展范围和重启恢复仍不会重复 grow。

历史游标必须与现有 live offset 分离。用户确认时，为所有已发现 source 把 live offset
原子设到当时 high-water，确保持续监听只处理安装后的增量；命中历史范围的 source 另外从
头建立 `historyCursor`，处理到同一个 high-water。这样“不导入历史”、以后扩展 coverage
和持续监听都有可推导的边界，而不是让一个 offset 同时表示两个方向。

### 7.4 数据流与顺序

```text
provider metadata discovery
        ↓（不读正文、不调用模型）
用户确认 cutoff + 当前 high-water
        ↓（原子写 import job）
按 session 最近活跃时间倒序进入有界优先队列
        ↓
同 session 保序；不同 session 最多两路 history roll；live 保留第三槽
        ↓
候选进入串行 commit gate，语境过期则重算
        ↓
offset/import cursor 先提交 → TreeRuntime 应用模型 op
        ↓
页面读取同一 snapshot，逐步出现真实工作线
```

跨 session 按最近活跃优先并最多两路并行，让首次价值更快出现；同一个 session 内必须保持
时间顺序。并行结果不直接写树：commit gate 检查 source/target 主线投影，相关语境变化就用
最新状态重算；写树仍然只有 `TreeRuntime` 一个入口。协议见
[`../decisions/0008-bounded-parallel-rolls.md`](../decisions/0008-bounded-parallel-rolls.md)。
首次选中的 session 在 history cursor 追到 high-water 前，必须暂缓同一 source 的 live
delta，避免先长出新结论再倒序补旧事实；其他 source 的 live delta 可以优先。以后扩展范围
时，如果一个较早 session 已因安装后重新活跃而进入地图，旧内容按“后来发现的历史背景”
交给专用 backfill prompt，只允许追加带来源时间的背景/修订关系，不能伪装成按原时间实时
长出的节点，也不能覆盖当前快照。该约束需要模型输出契约和测试证明，不能复用普通 roll
prompt 后假定顺序自然正确。

### 7.5 失败与重启

- job 创建、baseline 写入和每个 cursor 推进都走 `StateStore.update()` 原子替换。
- 继续采用 offset/cursor-before-apply 的 at-most-once 边界；极窄崩溃窗口允许少一次语义
  增量，不允许重复长出节点。
- source 在导入中被截断、替换或身份不匹配时停止该 item，展示具体错误，不把 cursor
  猜回 0。
- 模型不可用时 job 自动暂停，保留当前位置；恢复可用后由用户重试或自动继续，不能伪造
  完成。
- 页面关闭不暂停服务；服务重启按耐久 job 恢复。

### 7.6 安全边界

- inventory API 只返回 provider、session 数、日期、字节估计和经过截断/转义的 cwd 摘要，
  不把 transcript 正文暴露给浏览器。
- 开始、暂停、继续、取消和扩展范围都是同源回环 POST，复用现有 Origin 与 body 上限检查。
- transcript 正文仍只提供给用户选择的本机 roll engine；首次确认旁明确展示当前 engine。
- 不新增网络资产、analytics、telemetry、云账户或独立 worker。

### 7.7 迁移与回滚

- `createdAt` 早于引入该能力且已有 roots/sessions/offsets 的状态直接标为 onboarding complete，
  不弹首次引导、不改变 offset。
- 真正空的新状态才进入 discovery。损坏状态的 quarantine 流程不能被误判为授权回扫；应
  显示恢复错误，再让用户明确选择。
- 回滚旧 binary 时，新 intake 字段由 repair 忽略但树与 offset 仍可读取；在发布前需验证
  旧版不会因未知字段重置状态。由于 live baseline 同时落在旧版认识的 offset 中，回滚后
  不会静默导入确认前的旧内容；未完成的历史 job 可以暂停，但不能丢失已经形成的树。

## 8. 不采用的方案

### 安装后自动扫最近 60 个 session

实现最省事，但范围与成本不可见，缺少用户控制；60 是运行时容量常量，不是产品语义。

### 让用户选择“扫描所有历史”作为默认

首次价值慢、成本不可预测，选择压力和等待焦虑都高。可以作为高级选项，但不应默认。

### 时间范围只截 transcript 的最后一段

会从工作中段开始，模型容易把当前快照误当完整因果史。范围应选 session，选中后按完整
session 时间顺序处理。

### 先读尾部出结果，再反向补前文

虽然首屏快，但会让后读的旧事实反向长到新事实之后，破坏不可抹除轨迹的时间语义。除非
未来引入明确的“快照预览、不可 grow”通道，否则不采用。

### 用客户端 localStorage 保存 onboarding

更换浏览器/profile 后会重复引导，也无法保护模型调用与 offset。披露偏好可以留在本地，
导入计划必须在服务端同一状态文件。

## 9. 验收证据

### 行为与状态

1. 全新安装只做 metadata discovery，用户确认前不调用 roll engine、不增长树。
2. 7/30/90 天与自定义预览给出确定 session 集合，选中 session 按完整对话顺序消费。
3. “不导入历史”原子建立 baseline；重启后旧内容不被导入，新 append 仍正常生长。
4. 30 天完成后扩到 90 天，只新增较早 session，不重复既有节点或 session 入口。
5. 导入中关闭页面、重启服务、模型失败、source 迁移后，job 可恢复或给出具体失败。
6. 同时有 live transcript 时仍保持单写者、at-most-once 和同 source 顺序；两条 history
   在途时 live 仍能使用保留槽，相关主线变化会让 stale candidate 重算。
7. 旧状态升级不出现 onboarding，不改变任何 root、node、session、offset、engine 或归档。

### 认知与 UI

1. 5 秒可用性测试中，用户能说出“新内容会持续整理，时间选择只影响旧 session”。
2. 首屏主要决策不超过四个范围选项；主动作和范围结果空间相邻。
3. 400ms 内出现原位反馈；第一条真实工作线完成后立即可读，不等待整个 job。
4. 用户能暂停、跳过、稍后补扫；任何动作都不暗示缩短范围会删除地图。
5. 用户能区分“立即检查”和“补扫历史”；立即检查不改变 coverage、不重复 grow。
6. 代表性桌面与窄屏截图通过层级、对比度、溢出、键盘焦点、命中区和减少动态效果检查。
7. 完成主动作直接进入待处理或最近工作线，在三秒内回答产品宪章的四个问题。

### 证据强度与认知评分

- **当前空状态：3/10**。系统行为不可见、无控制、无进度，用户无法建立正确概念模型。
- **本提案：8/10**。可见性、映射、反馈、渐进披露、识别优于回忆和可逆性均有具体机制；
  剩余风险是等待时间估计是否可信，以及完整 session 导入的实际成本。
- 工作记忆容量、识别优于回忆、即时反馈与渐进披露有较成熟的实验和 HCI 证据。
- `400ms` 反馈和 `800ms` 后呈现下一引导是工程阈值；attentional blink 的强度具有任务
  特异性，必须通过真实交互测试校准，不能当成普适生理常数。
- “30 天推荐”不是心理学定律，而是待验证的产品假设。发布前应在本机 inventory 样本上
  比较 7/30/90 天命中 session 数、首条工作线时间和总模型调用量；如果 30 天经常超过
  20 个 session 或 10 分钟，应改为按发现结果动态推荐更小范围，并明确推荐理由。

## 10. 落地与持续校准

显式 baseline、耐久 7/30/90/自定义导入、范围扩展、后台进度、手动检查和 bounded keyed
workers 已落地。仍需用真实本机样本持续校准的是推荐阈值和粗略耗时文案；它们只能改变
默认推荐与展示，不得改变已确认 coverage、并发安全或 cursor 协议。
