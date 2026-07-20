# 迁移与发布模块

## 职责

把旧 Maintrail 状态一次性、可回滚地迁移到 SessionMap，并生成可独立运行的
SessionMap CLI 与无状态 macOS 展示壳。旧名称只作为迁移桥存在。

## 代码入口

- `src/migration.ts`：旧状态读取、schema 修复、语义保全验证和原子落盘。
- `src/launchd.ts`：旧 writer 停止、新服务启动、健康确认与失败回滚。
- `scripts/build.ts`：当前平台的 Bun standalone CLI。
- `scripts/build-macos-app.ts`、`desktop/macos/`：极薄 App 壳、universal 构建与图标。
- `scripts/install.sh`：按架构下载、校验并调用统一 CLI 安装事务。
- `scripts/macos/`：安装包架构选择、最小权限 postinstall 和 runtime 签名权限。
- `.github/workflows/ci.yml`：类型、测试、Web 与 CLI 构建门禁。
- `.github/workflows/release.yml`：tag/version 校验、双架构原生构建、签名、公证、冒烟、
  来源证明和 GitHub Release 发布。
- [`../decisions/0001-standalone-release-channels.md`](../decisions/0001-standalone-release-channels.md)：
  发布渠道、升级所有权与备选方案决策。
- [`../decisions/0004-map-document-desktop-hosts.md`](../decisions/0004-map-document-desktop-hosts.md)：
  App 只承载同一地图文档的边界。

## 发布契约

- 正式支持 macOS 13 及以上的 Apple Silicon 与 Intel Mac。arm64 使用
  `bun-darwin-arm64`；x86_64 使用兼容旧 Intel CPU 的 `bun-darwin-x64-baseline`。
- Git tag、`package.json` 和 CLI `--version` 必须一致，tag 格式为 `v<semver>`。
- GitHub Release 是 binary 唯一事实源。产物包含
  `sessionmap-<version>-darwin-{arm64,x86_64}.tar.gz`、自动选择本机架构的
  `SessionMap-<version>.pkg`、`checksums.txt` 和安装脚本；公开仓库发布同时生成 GitHub
  artifact provenance，私有测试发布由签名、公证与 SHA-256 提供完整性证据。
- CLI 使用 Developer ID Application 签名；安装包使用 Developer ID Installer 签名并经
  `notarytool` 公证、staple 和 Gatekeeper assessment。公证同时支持团队 API Key（带
  Issuer ID）和个人 API Key（不带 Issuer ID）。凭据只存在于本机安全归档和 GitHub
  Actions secrets，不进入 archive、日志或仓库。
- 安装包安装系统级只读来源 binary 和 universal `/Applications/SessionMap.app`，并以当前
  控制台用户调用 `sessionmap install` 后打开 App；状态、plist、迁移、健康确认与回滚仍
  只有 CLI 一个所有者。App 不内嵌第二份 runtime。
- Homebrew Formula 只安装 Release 中的 binary，不使用 `brew services`。安装和每次升级后
  都由用户显式运行 `sessionmap install`。
- 不后台检查或自动安装更新。降级时安装指定旧版本并再次运行同一 `install` 事务，用户
  状态不随 binary 降级而删除；跨 schema 降级必须由对应版本的迁移兼容性证据另行裁决。

## 不变量

- 迁移前记录旧状态 hash、revision、roots、sessions、offsets、engine 和归档。
- 迁移不能丢失任何耐久 root、node、session、offset 或 engine；offset 不得倒退。
- 成功健康检查后才移除旧 launchd 入口；失败必须恢复旧服务。
- 旧 plist 存在时，迁移前必须确认 `launchctl bootout` 成功；只有 launchd 明确返回
  “未加载”才可视为已冻结，其他失败必须在读取旧状态前中止。
- 安装前不存在的新状态目录属于本轮事务；迁移、bootstrap 或健康检查失败时必须清理，
  不能留下看似可用的半安装目录。已有状态目录不得被回滚误删。
- 重启后节点集合与 offsets 保持稳定，不重复 grow。
- Schema v4 增加 intake/history job；Schema v5 增加最小化的 session 排除标记。已有 roots、nodes、sessions 或 offsets 的旧安装升级时
  直接修复为 intake complete，不展示首次选择、不建立 baseline、不回扫；只有真正空的新
  状态进入 awaiting-choice。未完成 job 的 cursor、imported 标记与 live offsets 必须随
  原子状态一起保留，升级与重启都不得倒退。
- 发布产物不包含 token、QA 原始捕获、依赖目录或本机构建缓存。
- `bun run check` 的隐私门禁拒绝跟踪 `state.json`、状态目录、截图/捕获目录、具体本机用户
  路径和常见密钥形态；发布脚本仍只能从已跟踪源码与显式构建产物组装 archive。
- runtime 同时拒绝在 Git worktree 内创建状态目录；迁移与安装不得以仓库路径作为目标，
  从源头避免主题、session、脉络或快照成为待提交文件。
- 发布生成无状态 universal App，但不生成第二服务或业务客户端；`.pkg` 仍是已签名、公证
  的安装适配层，系统集成由 CLI 的 `install` 命令完成。
- 两个架构中任一构建、安装、健康、重启、签名或公证验证失败时不得创建 Release。

## 验证

运行 `bun run check`。发布 workflow 还必须在 arm64 和 x86_64 原生 runner 分别对 standalone
CLI 做 `--version`、架构、`install`、`/health` 和 launchd 重启冒烟；App 验证 universal
架构、受限导航、签名、冷启动与同一地图首帧；对安装包验证签名、
公证票据和 Gatekeeper assessment；生成 SHA-256 与 provenance；并比较迁移前后 roots、
nodes、sessions、offsets、engine 与归档集合。发布后从 `.pkg`、GitHub CLI archive 和
Homebrew tap 分别做一次净安装，确认服务健康、页面可直接打开、tag、Release target 与
远端一致。
