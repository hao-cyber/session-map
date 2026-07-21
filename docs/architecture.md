# SessionMap 架构说明

仓库采用私有 Bun workspace 组织的模块化单体；源码目录与构建、运行、发布边界的映射见
[仓库结构](repository-structure.md)，目录迁移决策见
[ADR 0013](decisions/0013-private-workspace-modular-monolith.md)。

## 产品不变量

SessionMap 是外置思维树。主线是一件正在推进的工作；session 只是只读数据源和树上的光标。结束 session 不能自动删除它承载的对象，启动替代 session 也不能机械地创建替代对象；用户明确执行隐私删除时例外。

“三秒恢复”按以下顺序回答：

1. **现在什么最需要我？** 左侧待处理分组先显示等拍板、等回复、等审阅与卡点。
2. **当时思考到哪里？** 稳定主线、失败尝试、close 原因、关键决定和 session 光标共同重建路径。
3. **怎样回到那里？** 每个 session 入口都能聚焦还活着的终端，或复活已经关闭的终端。入口不会被系统静默删除；用户可明确删除 SessionMap 记录。

更完整的产品裁决依据见 [产品与设计宪章](product-design.md)。

## 权限分工

模型拥有开放语义：

- session 归属哪条工作主线；
- 哪些变化属于结构性转折；
- ask 是 decision、review、reply 还是 none；
- 节点标签如何具体表达当时的思考判断与修订关系。

Runtime 不得用 cwd、关键词、正则或其他机械规则替代上述判断。

Runtime 拥有封闭边界：

- ID 分配与 schema 校验；
- 主线子树授权与 reattach 只读限制；
- 单写者串行化；
- transcript offset、原子持久化与幂等策略；
- 跳转、复活、发话等所有副作用。

模型输出始终是不可信输入。

## 组件关系

```text
Claude / Codex / Kimi / Grok / MiniMax provider source（只读）
        │
        ├─ provider registry：发现、身份、格式、cwd 与恢复协议
        ├─ watcher / intake coordinator：全量 metadata inventory、首次 baseline、耐久历史任务；
        │  常态 live 路径使用 linger、冷却和 60 个近期 session 上限
        ├─ adapter：提取结构信号，过滤 thinking 与工具结果正文
        │
        ▼
keyed bounded roll workers
        │  同 session 有序、不同 session 有界并行，得到候选 mainline / ask / ops
        ▼
串行 commit gate
        │  只校验并原子提交；过期候选释放 gate 后用最新状态重算
        ▼
Tree runtime（唯一写者）
        │  写边界、状态机、offset-before-apply、原子落盘
        ▼
state.json + open 回执签名密钥
        │
        ├─ loopback HTTP API / 本地静态资源
        ├─ 浏览器 / installed Web App / macOS 极薄壳中的同一地图文档
        ├─ sessionmap now 只读投影
        └─ Orca / iTerm2 / Terminal 动作层
```

Watcher 只采集与调度，永远不在轮询线程里等待慢模型。最多三个 roll worker，其中 history
最多占两个槽，给 live 保留一个槽；新 session 首次出现优先于普通 live，普通 live 优先于
history，同一逻辑 session 仍严格串行。模型输出只是候选，所有 cursor 提交与树应用经过短
串行 commit gate；候选依赖的主线已变化时释放 gate，再用最新状态有界重算。
Roll CLI 是 one-shot、无状态执行器；树和 offset 才是持久状态来源。完整取舍见
[ADR 0008](decisions/0008-bounded-parallel-rolls.md) 与
[ADR 0014](decisions/0014-short-commit-gate-and-priority-lanes.md)。

## 轨迹与滚动快照

SessionMap 不把任何模型摘要声明为不可变真理。它区分两种存储职责：

- 思考树保存不可静默抹除的历史轨迹。节点表达的是当时的尝试、发现、判断或决定；
  后续可以证明它错误，但必须用 close 原因和新方向显式记录修订。
- 每个 session 的 rolling snapshot 是可修订读取投影，包含整段 session 的稳定主标题、
  最新进展小标题和最多六个因果路标。它为模型滚动、目录和兼容服务，不承担历史审计
  职责，也不在 Web 中成为 session 私有历史；权威脉络始终是主题树。

因此“保留历史”与“允许改变认识”并不冲突：系统拒绝的是无痕覆盖，而不是修订本身。
状态机只允许 `waiting → active` 的 unblock。`resolved` / `dead` 是一次已经发生的历史
结论；若它后来重新可行，模型必须 grow 一个带新证据的新方向，而不是重开旧节点。

## 持久化与提交语义

`state.json` 同时保存思维树、live transcript offset、首次摄取/历史任务和最小化的 session 排除标记。每次写入都使用当前状态目录内的私有临时文件，执行 `fsync` 后原子 rename。这样 watcher、服务或 roll 任一环节崩溃重启，都不需要从 transcript 总头重新推导状态。

全新空状态先进入 `awaiting-choice`。Coordinator 只做全量 metadata inventory；用户确认时
为所有发现的 source 写入 live 高水位，并为命中范围且尚未导入的逻辑 session 建立独立
history cursor。历史 cursor 追到确认时的固定 `plannedSize` / snapshot 版本后标记 imported；
同 source 在此之前阻塞 live 消费，其他 source 仍可继续。历史任务和 live 都遵守
cursor-before-apply；瞬时单项失败耐久退避且不阻塞其他 session，全局引擎失败或耗尽重试后
暂停，重启从已提交游标继续。已有树、session 或 offset
的旧 schema 修复为 intake complete，绝不因升级触发回扫。完整取舍见
[ADR 0006](decisions/0006-explicit-history-intake.md)。

Session 首次进入状态时由 ingestion/runtime 写入 `firstSeenAt`，此后保持不变，作为同一主线
内稳定目录顺序的唯一依据。`lastTranscriptAt` 继续随只读 transcript 活动更新，但只用于
新近度展示与动作选择，不驱动目录换位。旧 schema 缺少 `firstSeenAt` 时，加载修复以
已有 `lastTranscriptAt` 回填并随下一次原子写入持久化。

Roll 故意采用 at-most-once：

1. 读取并过滤一个有界增量；
2. 获得并校验模型响应；
3. 先提交源 offset；
4. 再应用 ops 并原子落盘。

第三、四步之间发生极端崩溃时，最多丢失一次结构增量，但不会重复非幂等的 `grow`。对外置记忆而言，重复制造假节点比少一次更新更难被人识别和修复。

损坏的完整 JSON 会被隔离为 `.corrupt-<时间>` 后从空树恢复；字段缺失、悬空 children、自环或坏 cursor 等可修复损伤会被原地剪枝。加载路径不得进入 crash loop。

## 有界工作量

- 每次源文件读取最多 4 MiB；
- 无换行巨行超过 2 MiB 时直接跳过；
- 过滤后的语义增量硬上限 12 KiB；
- 当前主线子树最多约 120 行；
- 每轮最多 6 个 op；
- 同一 session 至少冷却 45 秒；
- 最多三个并发 roll，且 history 最多两个；
- 最多监控最近活跃的 60 个 transcript session。

标准目录、provider 环境变量目录与 Orca 管理的 Codex home 按 provider + session id
去重；同一 WAL 换路径时，逻辑 session 的持久 offset 会跟随它，避免重复生长。
Append-only JSONL 使用 byte offset；会被原子重写的 snapshot source 使用 mtime + 完整文件
边界，二者都在应用非幂等树操作前先提交消费位置。

Adapter 保留用户原文、assistant 对话文本、工具名计数与工具错误；丢弃 thinking、工具结果正文、tool_use 参数和系统注入。Memory、输入历史、索引和摘要只可用于补充 cwd / title，不能替代 provider 的恢复源。SessionMap 自己发起的 roll prompt 带固定哨兵，adapter 同时识别新旧品牌哨兵，防止升级期间自噬。

## 树写边界

一次合法 roll 只能修改它最终归属主线的子树。Runtime 会拒绝：

- 指向其他主线 node id 的 op；
- 不存在、形状错误或类型非法的 op；
- 对主线根执行 rename；
- 超过长度或数量上限的字段；
- 状态机不允许的 close / block / unblock；
- 自环或重复 children。

Session 从一条主线 reattach 到另一条主线的当轮，既有节点全部只读，只允许在新主线 grow 或把光标 refocus 到合法节点。这能阻止模型借“换主线”越权重写另一棵树。

## 对象恒存、历史与归档

resolved 和 dead 节点都是被明确记录过的历史判断，不会删除。新证据可以让当前快照
改写并生长替代方向，但不能让旧判断无痕消失。同层三个以上已闭合叶子会在渲染层
聚合成可展开的“历史”节点，减少阅读预算，但底层对象仍然完整。

Archive 只把主线移出当前阅读面，不停止 ingestion，不删除历史。恢复和 toast 撤销都操作同一个稳定 root id。

显式 session 删除走 TreeRuntime 单写者：清除 session、相关 offset/import/history 项，并写入
`provider:sessionId → deletedAt` 排除标记。Watcher 在 inventory、排队、提交和失败恢复边界
都检查该标记。若被删 session 是主题唯一入口，安全删除整棵主题树；共享主题缺少逐字段
来源归属，不能证明哪些节点只由该 session 产生，因此保留并在 UI 中如实披露。完整取舍见
[ADR 0011](decisions/0011-explicit-session-deletion-and-repository-privacy.md)。

Session 动作使用确定的降级阶梯。持久 handle 和 PID 只作为候选提示，不是可信身份：

1. 已知 Orca handle 由 Orca 切换命令现场验证；
2. 已知 PID 由它只读打开的 provider + session transcript 现场验证，再按 TTY 精确匹配
   iTerm2 / Terminal；
3. 快速路径失效时，并行刷新 Orca、transcript 与进程证据，重新解析现有 terminal；
4. 仍无活入口时，新建 terminal 执行 provider 的 resume 命令。

快速路径必须保持 O(1) 身份验证：缓存 handle 或 PID 命中时，不运行全量发现；只有快速
路径失效才并行刷新证据。恢复命令由 provider registry 唯一生成，动作层不得复制
provider 特例。完整取舍见 [ADR 0002](decisions/0002-provider-session-adapters.md)。

同一 session 的在途动作在浏览器和服务端同时去重。无法完成时必须给出明确错误，
不能让入口变成无反馈的假按钮。

## 本地地图文档、快速入口与服务

唯一正式界面是 Bun 服务提供的同一地图文档。系统浏览器是跨平台基线，installed Web App
和 macOS 极薄壳只提供独立窗口与 Dock 身份。Bun 服务同时负责 transcript watcher、状态写入、vendored
Web 资产和受回环同源边界保护的 API；服务端读取投影提供主题、主题唯一脉络、稳定
session 目录及脉络中的 cursor 标记。主题行分别拥有脉络披露与 Sessions 目录披露，
session 行以“回到终端”或“恢复终端”为主要动作，并提供明确的本地记录删除控制。展示容器只持有滚动、披露、局部相机、
窗口几何等读取偏好，不保存
第二份业务状态。任意本机浏览器或新 profile 直接打开固定地址都读取同一份真实 snapshot。
默认目录使用页面纵向滚动；二维平移缩放只属于按需展开的主题脉络，不能成为寻找
session 的旁路导航机制。

宽桌面的左侧待处理/工作线索引与右侧主题 section 由同一份 render projection 派生；
待处理项复用 `buildNowItems` 的优先级但过滤掉不要求用户行动的 busy/recent，工作线索引
只提供同页滚动锚点。Session 的 cwd 与时间来自持久状态；Git worktree、branch、dirty
和 ahead 由 monitor 对 cwd 只读采集并随 snapshot 返回，不进入状态文件或语义判断。

服务可由 `sessionmap serve` 前台运行，也可用 standalone CLI 的 `sessionmap install`
安装为当前用户的 launchd 服务。`sessionmap open` 负责打开页面并确认首帧；`sessionmap now`
只读同一行动优先级投影，编号跳转仍通过后台 HTTP 动作完成。macOS 壳在服务不健康时只调用统一
install 事务，不直接启动第二服务。Terminal、iTerm 和 Orca 仍是跳转/恢复适配层。

展示容器契约与回滚见 [ADR 0004](decisions/0004-map-document-desktop-hosts.md) 和
[桌面展示容器模块](modules/desktop-host.md)。

## 本地安全边界

服务只绑定 `127.0.0.1`，并把同一操作系统用户视为默认信任边界。根页面与
`/api/snapshot` 对回环浏览器直接可读，不建立 tab capability，也不发送 CORS 许可。
CLI 用状态目录中的私有签名密钥签发 30 秒 HMAC open ticket，只把 ticket 放入 URL
fragment；页面立即清除 fragment，通过同源 POST 登记 open id，完成首次 snapshot 与地图
渲染后发送 ready，CLI 轮询到 ready 才报告成功。这样 LaunchServices 的“已投递”不会再
被误判为“用户已看到”，同时 `sessionmap open` 不成为数据访问前置条件。状态变更请求必须满足：

Web 资产采用完整 bundle 内容版本。HTML、脚本、样式、vendor 和 CSS 图标引用共享该
版本；只有 URL 版本与当前 bundle 匹配时才返回 immutable，固定旧 URL 一律 no-store。
因此浏览器升级时不会把新启动脚本与旧 Maintrail/SessionMap 客户端拼成一个页面。

- Origin 的 scheme/host/port 属于允许的 loopback 页面；
- media type 严格解析为 `application/json`；
- `Content-Length` 不超过 64 KiB；
- body 是 JSON object。

模型标签、session 标题、git 字段都按不可信文本处理，先做 HTML escape，再实体化 Markdown 元字符，阻断 HTML 标签和 `x](javascript:...)` 两类注入。静态资源通过 realpath + 目录边界检查。Transcript 文件从不以写模式打开。

用户状态、运行日志和真实 UI 捕获不属于源码或发布输入。构建只嵌入显式 vendored Web 资产；
Git 隐私门禁拒绝状态目录、`state.json`、截图/捕获目录、具体 macOS 用户目录与常见密钥形态。
StateStore 在创建目录前向上检查 `.git` 边界，拒绝任何 Git worktree 内的 `--state-dir`，使真实
主题、session、脉络和快照不能因配置错误写进仓库工作树。

本机回环信任边界、备选方案与回滚见
[ADR 0003](decisions/0003-loopback-browser-trust.md)。

## 升级迁移

正式状态目录为 `~/Library/Application Support/SessionMap`，launchd label 为 `com.haocyber.sessionmap.service`。从旧版 Maintrail 升级时：

1. 不覆盖已经存在的 SessionMap 状态；
2. 在同一目标父目录内准备临时迁移目录；
3. 只复制并验证 `state.json` 与合法 token；
4. 原子 rename 成新状态目录；
5. 启动新服务并检查 `/health`；
6. 成功后移除旧 launchd plist 与旧 binary；
7. 失败则删除本轮新目录并恢复旧服务。

旧状态目录保留，不把安全回滚能力误当作应立即清理的垃圾。

## 发布与升级边界

GitHub Release 是 standalone binary 的唯一事实源。已签名、公证的 macOS 安装包、Homebrew
Formula 和校验安装脚本只是它的分发适配层，不直接写用户状态或管理 launchd。新装、升级
和降级最终都收敛到 `sessionmap install`，由 launchd 模块原子替换稳定路径中的 binary，
启动唯一 writer，确认 `/health` 后提交；失败则恢复旧 binary、plist 和服务。

每日发布候选 workflow 在 Asia/Shanghai 22:00 检查 `main`：只有精确 HEAD 已通过 CI、
再次通过完整发布门禁且相对最近 Release 有源代码变化时，才递增 beta 并创建不可变 tag。
版本元数据提交由 tag 独占，不绕过受保护的 `main`；`Release-Source` trailer 保存真实源提交。
tag 显式 dispatch 同一 Release workflow，成功发布后再从 `checksums.txt` 确定性生成并推送
Homebrew Formula。Release 仍是唯一事实源，tap 不构建 binary，也不能反向写主仓库。完整
失败恢复与权限取舍见 [ADR 0015](decisions/0015-daily-tested-release-automation.md)。

macOS 安装包把对应架构的已签名 binary 放到系统只读来源路径，并安装一个 universal、
无状态的 SessionMap App 壳，再以当前控制台用户身份调用统一安装事务。App 承载同一地图
文档但不成为第二个 runtime。发布
渠道的完整决策、失败模型与备选方案见
[ADR 0001](decisions/0001-standalone-release-channels.md)，操作契约见
[迁移与发布模块](modules/migration-release.md)。
