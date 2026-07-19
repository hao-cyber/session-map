# SessionMap 架构说明

## 产品不变量

SessionMap 是外置思维树。主线是一件正在推进的工作；session 只是只读数据源和树上的光标。结束 session 不能删除它承载的对象，启动替代 session 也不能机械地创建替代对象。

“三秒恢复”按以下顺序回答：

1. **现在什么最需要我？** now-bar 先显示等拍板、等回复、卡点与刚完成的新产出。
2. **当时思考到哪里？** 稳定主线、失败尝试、close 原因、关键决定和 session 光标共同重建路径。
3. **怎样回到那里？** 每个 session 入口都能聚焦还活着的终端，或复活已经关闭的终端。入口只衰减，不消失。

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
Claude / Codex transcript JSONL（只读、append-only）
        │
        ├─ watcher：发现文件变化、linger、冷却、60 session 上限
        │
        ├─ adapter：提取结构信号，过滤 thinking 与工具结果正文
        │
        ▼
串行 roll worker
        │  一次性调用选定模型，得到 mainline / ask / ops
        ▼
Tree runtime（唯一写者）
        │  写边界、状态机、offset-before-apply、原子落盘
        ▼
state.json + open 回执签名密钥
        │
        ├─ loopback HTTP API / 本地静态资源
        ├─ 系统浏览器中的 SessionMap
        └─ Orca / iTerm2 / Terminal 动作层
```

Watcher 只采集与调度，永远不在轮询线程里等待慢模型。Roll CLI 是 one-shot、无状态执行器；树和 offset 才是持久状态来源。

## 轨迹与滚动快照

SessionMap 不把任何模型摘要声明为不可变真理。它区分两种存储职责：

- 思考树保存不可静默抹除的历史轨迹。节点表达的是当时的尝试、发现、判断或决定；
  后续可以证明它错误，但必须用 close 原因和新方向显式记录修订。
- 每个 session 的 rolling snapshot 是可修订读取投影，包含整段 session 的稳定主标题、
  最新进展小标题和最多六个因果路标。它为目录和三秒恢复服务，不承担历史审计职责。

因此“保留历史”与“允许改变认识”并不冲突：系统拒绝的是无痕覆盖，而不是修订本身。
状态机只允许 `waiting → active` 的 unblock。`resolved` / `dead` 是一次已经发生的历史
结论；若它后来重新可行，模型必须 grow 一个带新证据的新方向，而不是重开旧节点。

## 持久化与提交语义

`state.json` 同时保存思维树和 transcript offset。每次写入都使用当前状态目录内的私有临时文件，执行 `fsync` 后原子 rename。这样 watcher、服务或 roll 任一环节崩溃重启，都不需要从 transcript 总头重新推导状态。

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
- 最多监控最近活跃的 60 个 transcript session。

标准目录、环境变量目录与 Orca 管理的 Codex home 按 provider + session id 去重；同一 WAL 换路径时，逻辑 session 的持久 offset 会跟随它，避免重复生长。

Adapter 保留用户原文、assistant 对话文本、工具名计数与工具错误；丢弃 thinking、工具结果正文、tool_use 参数和系统注入。SessionMap 自己发起的 roll prompt 带固定哨兵，adapter 同时识别新旧品牌哨兵，防止升级期间自噬。

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

Session 动作使用确定的降级阶梯。持久 handle 和 PID 只作为候选提示，不是可信身份：

1. 已知 Orca handle 由 Orca 切换命令现场验证；
2. 已知 PID 由它只读打开的 provider + session transcript 现场验证，再按 TTY 精确匹配
   iTerm2 / Terminal；
3. 快速路径失效时，并行刷新 Orca、transcript 与进程证据，重新解析现有 terminal；
4. 仍无活入口时，新建 terminal 执行 provider 的 resume 命令。

同一 session 的在途动作在浏览器和服务端同时去重。无法完成时必须给出明确错误，
不能让入口变成无反馈的假按钮。

## 本地网页与服务

系统浏览器是唯一产品界面。Bun 服务同时负责 transcript watcher、状态写入、vendored
Web 资产和受回环同源边界保护的 API；服务端读取投影提供主题、稳定 session 目录、
有界 session 脉络与主题全貌结构，浏览器只持有滚动、披露和局部相机等读取偏好，不保存
第二份业务状态。任意本机浏览器或新 profile 直接打开固定地址都读取同一份真实 snapshot。
默认目录使用页面纵向滚动；二维平移缩放只属于
按需展开的主题全貌，不能成为寻找 session 的旁路导航机制。

服务可由 `sessionmap serve` 前台运行，也可用 standalone CLI 的 `sessionmap install`
安装为当前用户的 launchd 服务。`sessionmap open` 负责打开页面并确认首帧。Terminal、iTerm
和 Orca 仍是跳转/恢复适配层，但不构成原生 SessionMap 客户端。

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
