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
- capability 从 URL fragment 进入 `sessionStorage`；公开根页面和日志不得泄露 token。
- Web runtime 全部 vendored，不允许 CDN、远程字体、analytics 或 telemetry。

## 披露与视窗协议

- 内容披露与相机导航是两套独立状态。平移、缩放、Fit、窗口 resize 或节点进入视窗
  只能改变观察位置和比例，不能展开或折叠节点。
- 首次出现且没有用户选择的 session 脉络与主题全貌默认折叠；主题和 session 目录
  默认可见。默认值由读取模型声明，不从缩放比例、视窗位置或节点深度猜测。
- 用户通过结构行、Markmap 节点控件或 session 行内“脉络”控件明确切换披露状态。
  状态以稳定节点 ID 写入浏览器本地存储，并在数据刷新后恢复；本地存储不可用时，
  至少在当前页面生命周期内保留。
- 数据刷新改变布局时，读取层钉住离视窗中心最近的稳定节点；不得借刷新重置用户
  已选择的披露状态。

## 验证

自动覆盖在 `tests/web-assets.test.ts` 与 `tests/render-actions-server.test.ts`。UI 改动还必须
用代表性桌面尺寸生成真实截图，检查三层层级、溢出、命中区、状态反馈、Fit、披露
持久性和热更新。交互验证必须覆盖：展开一个脉络后执行 pan、zoom、Fit 与 resize，
该脉络保持展开；折叠一个结构节点后执行同样操作，该节点保持折叠。
