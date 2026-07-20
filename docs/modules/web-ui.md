# Web 读取层模块

## 职责

呈现固定的读取地图：主题/工作主线 → 主题唯一脉络 + Sessions 入口目录。常态是纵向
滚动的主题与 session 目录；系统浏览器、installed Web App 和
macOS 极薄壳承载同一份正式地图文档。

## 代码入口

- `src/render.ts`：把状态投影成读取模型与安全 HTML。
- `web/index.html`、`web/styles.css`、`web/app.js`：结构、视觉与交互。
- `web/manifest.webmanifest`、`web/sessionmap-icon.svg`：可安装窗口 metadata 与本地图标。
- `src/assets.ts`：vendored runtime 资产加载与热更新。
- `src/server.ts`：快照、事件流和回环同源边界。
- [`../decisions/0005-integrate-attention-into-directory.md`](../decisions/0005-integrate-attention-into-directory.md)：
  删除独立 Now 条并把行动优先级整合进目录的决策。
- [`../decisions/0007-theme-owned-lineage.md`](../decisions/0007-theme-owned-lineage.md)：
  主题拥有唯一脉络的决策。
- [`../decisions/0009-theme-controls-lineage-session-controls-terminal.md`](../decisions/0009-theme-controls-lineage-session-controls-terminal.md)：
  脉络控制收敛到主题、session 只控制终端的决策。

## 不变量

- 第一层是主题，不得把 session 提升为一级对象。
- Session 行同时保留整体主标题、最新有意义进展小标题、实时终端状态与动作入口。
- 同一主题内的 Session 行按持久化 `firstSeenAt` 倒序排列；已有行不因 transcript 活动、
  ask 或终端状态变化而换位。`lastTranscriptAt` 只以弱文字显示，不参与目录排序。
- 每个主题只有一份可展开的完整因果脉络；session cursor 只作为其中的节点标记，session
  不拥有或展开私有脉络，也不提供脉络按钮。`snapshot.trail` 可保留在兼容读取快照中，
  但 Web 不把它画成第二条历史。
- 主题形成纵向 section，session 形成稳定目录行。目录使用浏览器原生纵向滚动、滚动条
  和键盘导航；不得要求用户拖动二维画布才能找到 session。主题脉络以可折叠的缩进大纲
  内联展开，与目录共享同一页面滚动，不设第二套平移缩放导航。
- 宽桌面左侧先显示只含 decision/reply/review/blocker 的待处理分组，再显示工作线索引。
  待处理项跳转到 session，工作线点击只滚动到同页对应主题 section，并随页面位置标记
  当前主题；两者都不保存业务状态、不改变主题顺序，也不把 session 提升为一级。窄屏
  隐藏工作线索引但保留待处理分组。
- Session 行把持久 `cwd`、`firstSeenAt`、`updatedAt` 与 monitor 的只读 Git worktree /
  branch 投影整合在标题附近。Git 不可用时隐藏 Git 片段，目录、时间和恢复入口仍须可用。
- 页面不得建立独立的横向 Now 状态条。行动优先级必须收敛在左侧待处理分组和行内状态，
  避免与工作线目录重复、挤压首屏或伪装成导航 tab。
- 任意本机现代浏览器、任意 profile 或新标签页直接打开固定地址，都读取服务端同一份
  真实 snapshot；读取不得依赖浏览器 token、特定 tab 或 `sessionmap open`，也不得用
  演示数据填充空白。
- 全新状态用正式地图文档内的首次摄取面板解释两件事：后台会持续整理新对话，时间选择
  只影响一次性旧 session 导入。范围提供 7 天、30 天、90 天和自定义起始日；30 天候选
  不超过 20 个时推荐 30 天，超过时推荐 7 天并提示任务较大，
  并在动作旁显示真实候选 session 数与估计体量；没有候选时允许直接进入真实空地图。
- 导入中显示已完成/总数、当前 provider/session、暂停、继续、取消和“先看地图”；第一条
  真实工作线生成后即可阅读，不必等全任务结束。用户点击开始后默认立即收起面板并进入
  地图，状态行持续显示完成数；“历史进度”可随时重新打开控制面。完成后工具栏保留低显著的
  “补扫历史”。运行态同时显示当前并行路数，并说明历史最多两路、live 有保留槽；不得用
  百分比暗示确定完成时间。“立即检查”始终是状态动作，不叫“刷新”，不得暗示清空或重跑。
- 当前 Roll 引擎仍在检查、未安装、未登录或最近失败时，历史主按钮禁用并在原位说明原因；
  后台任务失败后状态行与进度面显示 paused 和经过截断的具体错误，不能表现成静默卡住。
- URL fragment 只接收短期一次性 open ticket，并立即清理地址栏。Ticket 只关联 CLI
  的首次可见帧回执，不授予 snapshot 或动作权限，不写入长期浏览器凭据。
- 页面完成首次 snapshot 与地图渲染后才发送 open ready。Ticket 过期或回执登记失败只
  影响 CLI 的打开确认，页面仍继续直接读取本机数据。
- open ticket 在 ready 成功前保留于当前 tab；若兑换后、ready 前服务重启导致 open ID
  丢失，页面必须用仍有效的 ticket 重新登记并回执，成功或过期后立即清除 ticket。
  若同一服务进程中页面在 ready 前 reload，已有 open ID 时不得重复登记并把 409
  误判为失效；应继续首次渲染与 ready 回执。
- HTML 中每个 JS/CSS/vendor 入口都必须携带由完整嵌入式 Web bundle 内容生成的版本；
  CSS 引用的图标同样带版本。只有匹配当前版本的资产响应可以使用 immutable 缓存，
  无版本或版本不匹配的请求必须 `no-store`，避免新 HTML 与旧 JS 跨版本混装。
- Web runtime 全部 vendored，不允许 CDN、远程字体、analytics 或 telemetry。
- Manifest 只声明同源根地址、standalone 窗口和 vendored 图标；不得注册 service worker、
  离线状态副本或浏览器专属业务入口。所有展示容器继续读取同一 snapshot。

## 脉络大纲排印

- 脉络是因果叙事，不是清单：goal 级节点以 14px/650 作小节标题，节点间留出小节距；
  其余结构节点保持 12px 单行。
- `decision`、`blocker` 与 `dead` 节点使用双行叙事块：标签一行，原因（note）以
  11px、行高 1.6 放在第二行，最多三行（line-clamp）；死路关闭原因因此完整可读。
  双行块的折叠控件钉在第一行中心，而不是整个块的中心。
- 当前落点用“⌖ + provider”小牌标记（低对比描边 pill，置于节点标签行尾），
  安静但一眼可认；它仍是跳回对应 session 的入口。
- 缩进为 18px/级；导线保持唯一分支色，当前路径的导线墨色加深，其余子树导线减淡。

## 披露与滚动协议

- 内容披露与目录滚动是两套独立状态。页面滚动、窗口 resize 或节点进入视窗只能改变
  观察位置，不能展开或折叠节点。
- 首次出现且没有用户选择的主题完整脉络默认折叠，Sessions 目录默认展开。
  默认值由读取模型声明，不从滚动位置或节点深度猜测。
- 主题行上的“脉络/收起脉络”按钮控制主题唯一脉络；主题标题行单击或行首折叠控件只
  控制该主题的 Sessions 目录。两份披露状态相互独立，以稳定主题 ID
  写入浏览器本地存储，并在数据刷新后恢复；本地存储不可用时，至少在当前页面生命
  周期内保留。
- Sessions 目录折叠时只隐藏 session 列表；主题标题、状态词、session 计数和主题脉络
  控件保留在原位。脉络披露不随 Sessions 目录折叠而改变，反之亦然。待处理跳转（终端
  动作）与工作线索引滚动都不依赖 Sessions 目录是否展开。
- 主题脉络控件在折叠时显示“脉络”、展开后显示“收起脉络”。它在同一主题 section 内
  原地以缩进大纲披露结构树，不进入新页面、不创建 focus 模式或返回栈，也不隐藏相邻
  主题。首次展开且尚无用户选择时，大纲只揭示当前路径（活跃节点链与 session 光标
  祖先），其余子树保持折叠；逐节点折叠状态同样以稳定节点 ID 持久化。
- Session 行不提供“脉络”或“定位脉络”按钮，单击不改变任何披露状态。行尾根据实时
  终端状态显示“回到终端”或“恢复终端”；双击行执行同一终端动作，明确按钮立即执行并
  阻止事件冒泡。异步失败必须显示错误，不能留下未处理 Promise。
- Session 行尾的低显著删除控制只删除 SessionMap 记录并持久排除。确认文案必须说明原始
  transcript 不受影响，以及共享主题脉络可能保留；删除控制不能触发双击跳转。
- 动作触发后，按钮必须在原位立即显示“回到中…”或“恢复中…”并进入 disabled / busy
  状态；toast 只报告最终结果，不能承担唯一的进行中反馈。
- 同一个 session 的跳转或恢复在请求完成前只能有一个在途动作；双击明确按钮或快速
  重复触发不得创建两个终端、发送两次恢复命令或产生并发副作用。
- 数据刷新、窗口 resize 或其他行展开导致目录重排时，读取层钉住离视窗上方阅读热区
  最近的稳定主题/session 行。不得借重排或刷新重置用户已选择的披露状态。

## 验证

自动覆盖在 `tests/web-assets.test.ts` 与 `tests/render-actions-server.test.ts`。UI 改动还必须
用代表性桌面尺寸在浏览器和 App 中生成真实截图，检查主题/脉络/Sessions 归属、长目录滚动、溢出、命中区、状态反馈、
披露持久性和热更新。交互验证必须覆盖：主题标题只折叠 Sessions 目录，主题
“脉络”按钮只展开主题唯一脉络，两者互不改写；session 不显示脉络按钮，单击不改变披露，
双击和“回到终端/恢复终端”执行同一终端动作；展开主题脉络大纲后执行页面滚动、resize 与刷新，
大纲与逐节点披露状态保持；首次展开只揭示当前路径。动态布局后必须按稳定 `data-node-id` 重新查询，
不得用旧 element/locator 的结果判断交互成败。首轮验收还必须等待 `#loading[hidden]`，
不能在目录初始渲染尚未结束时用移动中的坐标制造假失败。
