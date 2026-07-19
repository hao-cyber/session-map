# 迁移与发布模块

## 职责

把旧 Maintrail 状态一次性、可回滚地迁移到 SessionMap，并生成可独立运行的
SessionMap CLI。旧名称只作为迁移桥存在。

## 代码入口

- `src/migration.ts`：旧状态读取、schema 修复、语义保全验证和原子落盘。
- `src/launchd.ts`：旧 writer 停止、新服务启动、健康确认与失败回滚。
- `scripts/build.ts`：当前平台的 Bun standalone CLI。
- `.github/workflows/ci.yml`：类型、测试、Web 与 CLI 构建门禁。

## 不变量

- 迁移前记录旧状态 hash、revision、roots、sessions、offsets、engine 和归档。
- 迁移不能丢失任何耐久 root、node、session、offset 或 engine；offset 不得倒退。
- 成功健康检查后才移除旧 launchd 入口；失败必须恢复旧服务。
- 旧 plist 存在时，迁移前必须确认 `launchctl bootout` 成功；只有 launchd 明确返回
  “未加载”才可视为已冻结，其他失败必须在读取旧状态前中止。
- 安装前不存在的新状态目录属于本轮事务；迁移、bootstrap 或健康检查失败时必须清理，
  不能留下看似可用的半安装目录。已有状态目录不得被回滚误删。
- 重启后节点集合与 offsets 保持稳定，不重复 grow。
- 发布产物不包含 token、QA 原始捕获、依赖目录或本机构建缓存。
- 发布不生成 App、Cask 或 Apple 公证产物；系统集成由 CLI 的显式 `install` 命令完成。

## 验证

运行 `bun run check`，对 standalone CLI 做 `--version`、`install`、`/health` 和重启冒烟，
并比较迁移前后 roots、nodes、sessions、offsets、engine 与归档集合。
