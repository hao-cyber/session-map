# SessionMap 项目指令

## 产品事实源

- 修改产品行为、UI、信息架构、命名、持久化、运行时或分发之前，必须完整阅读
  [`docs/product-design.md`](docs/product-design.md)。
- 该文档是产品与设计宪章。功能规格、设计稿、框架惯例或实现便利与它冲突时，
  以其中的裁决优先级为准。
- 不变的结果目标是：用户切回任何一条工作线时，能在三秒内找回此前的思考位置。

## 模块文档索引

- 全局组件关系、写入协议与安全边界：[`docs/architecture.md`](docs/architecture.md)
- 状态模型、轨迹、快照与树操作：[`docs/modules/state-model.md`](docs/modules/state-model.md)
- transcript 发现、增量采集与模型滚动：[`docs/modules/ingestion.md`](docs/modules/ingestion.md)
- session 关联、终端状态、切换与恢复：[`docs/modules/session-navigation.md`](docs/modules/session-navigation.md)
- 主题 → session → 脉络的 Web 读取层：[`docs/modules/web-ui.md`](docs/modules/web-ui.md)
- 本地 Web 服务、浏览器入口与 launchd：[`docs/modules/local-runtime.md`](docs/modules/local-runtime.md)
- 旧状态迁移、standalone CLI 与发布：[`docs/modules/migration-release.md`](docs/modules/migration-release.md)

先按改动范围读取对应模块文档；跨模块改动同时读取所有受影响文档。模块文档解释
“代码现在如何守住契约”，不得覆盖或重新解释产品宪章。

## 问题求解与文档演进

- 遇到卡点、反复失败或问题边界不清时，先整理已知事实、约束、假设和未知量，再把
  具体故障抽象成若干可检索的问题。确认它是否已有成熟的问题名称、理论模型、标准
  解法或业界实践；优先查阅一手资料和成熟实现，并明确外部解法与本项目约束的映射，
  不得未经验证直接照搬。
- 修改模块前必须阅读对应模块文档；改动使现有职责、契约、数据流、边界或验证方式
  发生变化时，功能与相关文档必须在同一改动中更新。文档描述当前真实设计，不把
  changelog 混入正文；实现细节不得反向篡改产品宪章。
- 文档随模块增长而变得过长、混合多个可独立理解的子主题，或单文件已难以可靠导航时，
  按 hub-and-spoke 方式拆分：hub 保留职责、核心不变量、全局关系和 spoke 索引，spoke
  承载具体协议、流程或子模块细节。Hub 与 spoke 必须双向链接；新增一级模块边界时同步
  更新本文件的模块文档索引，避免产生不可发现的孤立文档。

## 架构变更门禁

- 改动跨越模块边界，或改变职责、数据所有权、写入路径、信任边界、生命周期、失败恢复
  与分发方式时，编码前先完成轻量架构审查。
- 审查至少明确：受影响契约、唯一事实源与写入者、数据流和依赖方向、失败与重启行为、
  安全边界、迁移与回滚方式，以及能够证明这些约束的验证证据。
- 重大架构决策必须记录背景、约束、备选方案、取舍和后果；后续推翻时标记替代关系，
  不得静默改写历史决定。
- 删除旧实现、旧状态或兼容桥之前，必须证明新路径完成真实迁移、重启恢复、回滚和安装
  冒烟；“新实现能运行”不等于“旧路径可以清理”。

## 不可退让的工程契约

- 一级对象是工作主线，绝不是 session。Session 归属、结构转折和 ask 语义由模型
  判断；runtime 只负责 ID、schema、边界、串行化与副作用。
- 使用“不可抹除的思考轨迹 + 可修订的当前快照”：旧判断可以被证伪或替代，但必须
  留下原因和修订关系；不得把模型摘要称作不可变事实，也不得用新快照覆盖历史。
- 地图读取层级固定为主题 → session → 可展开脉络/主题全貌。Session 行必须保留
  整体主标题、最新进展小标题、实时终端状态和可靠的跳转/恢复入口。
- 保持对象恒存：节点、死路和 session 入口只能衰减或归档，不能静默消失。
- 保持 at-most-once 生长、单写者、原子状态替换、transcript 只读、有界 roll 输入
  和回环 capability 安全。
- 浏览器页面、CLI 和后台任务共享一个 Bun 服务和一个持久状态文件；不得创建第二套
  状态模型，也不得为了“多端”绕过回环 capability 安全。
- Web runtime 资产必须 vendored。禁止添加 CDN、analytics、telemetry 或远程字体。

## 工作约定

- TypeScript 核心、Web UI 与构建工具统一使用 Bun；不要引入原生壳或 Electron。
- 逻辑改动运行 `bun run check`；发布改动还必须构建 standalone CLI 并做安装冒烟。
- UI 改动必须生成代表性桌面尺寸的真实截图，检查层级、对比度、溢出、命中区、
  交互反馈和模板感。
- 白色视觉系统必须保持语义：结构色中性；红、琥珀、绿、紫只承担产品宪章规定的
  状态和新近度。
- 保留用户无关改动。暂存前检查 `git status --short`，只暂存明确路径；禁止提交
  依赖目录或构建产物。
