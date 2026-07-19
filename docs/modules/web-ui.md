# Web 读取层模块

## 职责

呈现固定的三层地图：主题/工作主线 → session → 可展开因果脉络，并提供独立的主题
全貌入口。系统浏览器是唯一正式产品界面。

## 代码入口

- `src/render.ts`：把状态投影成读取模型与安全 HTML。
- `web/index.html`、`web/styles.css`、`web/app.js`：结构、视觉与交互。
- `src/assets.ts`：vendored runtime 资产加载与热更新。
- `src/server.ts`：快照、事件流和 capability 边界。

## 不变量

- 第一层是主题，不得把 session 提升为一级对象。
- Session 行同时保留整体主标题、最新有意义进展小标题、实时终端状态与动作入口。
- 展开后呈现 2–6 个因果脉络；主题全貌是独立入口，不混进单个 session。
- URL fragment 只接收短期一次性 open ticket；页面同源兑换 capability 后写入当前 tab
  的 `sessionStorage` 并清理地址栏。公开根页面、URL、日志不得泄露长期 token。
- 页面完成首次 snapshot 与地图渲染后才发送 open ready。401 清除当前 tab 的失效
  capability 并明确提示运行 `sessionmap open`；不得把鉴权失败归为临时服务故障。
- HTML 中每个 JS/CSS/vendor 入口都必须携带由完整嵌入式 Web bundle 内容生成的版本；
  CSS 引用的图标同样带版本。只有匹配当前版本的资产响应可以使用 immutable 缓存，
  无版本或版本不匹配的请求必须 `no-store`，避免新 HTML 与旧 JS 跨版本混装。
- Web runtime 全部 vendored，不允许 CDN、远程字体、analytics 或 telemetry。

## 披露与视窗协议

- 内容披露与相机导航是两套独立状态。平移、缩放、Fit、窗口 resize 或节点进入视窗
  只能改变观察位置和比例，不能展开或折叠节点。
- 首次出现且没有用户选择的 session 脉络与主题全貌默认折叠；主题和 session 目录
  默认可见。默认值由读取模型声明，不从缩放比例、视窗位置或节点深度猜测。
- 用户单击 session 行或其“脉络”控件，切换该 session 的披露状态；双击 session 行
  会取消待执行的单击折叠并立即回到终端或恢复。行尾“回到终端/恢复”按钮为键盘与触控提供
  明确动作入口。结构行和 Markmap 节点控件继续控制其他分支。披露状态以稳定节点 ID
  写入浏览器本地存储，并在数据刷新后恢复；本地存储不可用时，至少在当前页面生命
  周期内保留。
- Session 行交互按稳定节点 ID 实现短暂状态机：单击先进入待披露态；同一节点的双击
  在延迟期内取消待披露并执行跳转；“脉络”和“回到终端/恢复”按钮不进入延迟态，而是
  立即执行且阻止事件冒泡。异步失败必须显示错误，不能留下未处理 Promise。
- 动作触发后，按钮必须在原位立即显示“回到中…”或“恢复中…”并进入 disabled / busy
  状态；toast 只报告最终结果，不能承担唯一的进行中反馈。
- 同一个 session 的跳转或恢复在请求完成前只能有一个在途动作；双击明确按钮或快速
  重复触发不得创建两个终端、发送两次恢复命令或产生并发副作用。
- 数据刷新改变布局时，读取层钉住离视窗中心最近的稳定节点；不得借刷新重置用户
  已选择的披露状态。

## 验证

自动覆盖在 `tests/web-assets.test.ts` 与 `tests/render-actions-server.test.ts`。UI 改动还必须
用代表性桌面尺寸生成真实截图，检查三层层级、溢出、命中区、状态反馈、Fit、披露
持久性和热更新。交互验证必须覆盖：单击 session 展开脉络；双击 session 只跳转且
不遗留单击展开；展开一个脉络后执行 pan、zoom、Fit 与 resize，该脉络保持展开；
折叠一个结构节点后执行同样操作，该节点保持折叠。Markmap 重排期间可能短暂保留
退出中的 DOM；真实浏览器验收每次布局变化后都必须按稳定 `data-node-id` 重新查询，
不得用旧 element/locator 的结果判断交互成败。首轮验收还必须等待 `#loading[hidden]`，
不能在地图初始布局与 Fit 尚未结束时用移动中的坐标制造假失败。
