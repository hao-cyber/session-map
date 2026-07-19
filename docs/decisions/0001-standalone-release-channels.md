# ADR 0001：以 standalone CLI 为唯一发布单元

> 状态：部分被 [ADR 0004](0004-map-document-desktop-hosts.md) 替代；standalone CLI、单写者、安装事务与回滚部分仍有效  
> 日期：2026-07-20

## 背景与约束

SessionMap 的唯一正式界面是回环 Bun 服务提供的系统浏览器页面。CLI、后台 watcher、
Web 服务和 launchd 生命周期共享一个 runtime、一个状态文件与一个写入者。发布便利不能
产生第二套界面、状态模型、写入路径或信任边界。

首个公开版本需要同时覆盖 Apple Silicon 和仍在使用的 Intel Mac，并让不了解终端、Bun
或 Homebrew 的用户也能通过系统 Installer 完成体验；安装和升级仍必须保留既有迁移、
健康确认和失败回滚语义。项目不采用拥有业务状态的原生客户端、Homebrew Cask 或
Electron；无状态 App 展示壳由 ADR 0004 单独约束。

## 决策

- Git tag、`package.json` 版本与 GitHub Release 一一对应，tag 使用 `v<semver>`。
- GitHub Actions 分别在原生 arm64 与 x86_64 macOS runner 上构建 Bun standalone CLI，
  不把未经原生执行验证的交叉编译产物作为正式发布物。
- GitHub Release 是二进制唯一事实源，包含两个架构 archive、一个按机器选择架构的
  `.pkg`、安装脚本和 SHA-256 清单；仓库公开时同时生成 GitHub artifact provenance
  attestation，私有测试发布继续由 Developer ID、公证和校验和建立完整性证据。
- CLI 使用 Developer ID Application 签名；`.pkg` 使用 Developer ID Installer 签名并经
  Apple 公证、staple 和 Gatekeeper assessment。任一步失败都不创建 Release。
- `.pkg` 安装系统级只读来源 binary 和 ADR 0004 定义的 universal 无状态 App 壳，再以
  当前控制台用户调用统一 CLI 安装事务并打开 App；它不是状态写者或第二个后台服务。
- Homebrew tap 只包装对应 GitHub Release 中的同一个 CLI。Formula 不注册第二个服务；
  用户仍显式执行 `sessionmap install`，由 CLI 原子替换 `~/.local/bin/sessionmap` 并管理
  唯一 launchd writer。
- 安装和升级都是显式用户动作。首发不加入后台自动更新器；升级后的 binary 仍通过
  `sessionmap install` 完成健康检查和失败回滚。
- 正式支持 macOS 13 及以上。x86_64 使用 Bun baseline target；arm64 使用标准 target。

## 数据流、失败与安全边界

```text
tag + source
    │  CI/check + native build + install/restart smoke
    ▼
GitHub Release archives + checksums + provenance
    │
    ├─ notarized .pkg ──────┐
    ├─ verified install.sh ─┤
    └─ Homebrew Formula ────┴─► sessionmap install
                                      │
                                      ▼
                         ~/.local/bin/sessionmap
                                      │
                                      ▼
                    one launchd service + one state.json
```

Release workflow 只有两个架构都通过 `--version`、真实 `install`、`/health` 与 launchd
重启恢复，并且安装包通过签名、公证和 Gatekeeper 验证后才创建 Release。安装脚本先下载
SHA-256 清单并验证 archive，再执行其中的 CLI。发布渠道不接触 capability token、状态
文件或 transcript。

安装失败继续由现有 CLI 事务回滚：新服务未健康时恢复旧 binary、plist 和旧服务；首次
安装创建的半状态目录被清理。发布回滚不删除用户状态，而是重新安装上一版本 archive
并再次通过相同健康门禁。

## 备选方案与取舍

- **只发源码/npm 包**：用户必须安装 Bun，且安装结果受本机依赖解析影响，不作为公众
  默认入口；源码运行仍保留给贡献者。
- **DMG/Homebrew Cask/拥有业务逻辑的 App**：会引入另一套安装所有权或第二个产品实现，
  因此拒绝。系统 `.pkg` 只做安装适配；其中的无状态 App 只承载同一地图文档，全部业务与
  生命周期操作仍委托给现有 CLI。
- **Homebrew `service`**：会与 CLI 自己的 launchd 事务形成两个服务所有者，因此拒绝。
- **自动更新器**：需要新的网络、副作用和回滚机制；在真实升级证据充分前不引入。

## 后果

用户不需要安装 Bun 或 Homebrew；普通用户下载一个公证安装包，开发者仍可选择 CLI 和
Formula。每次发布必须同步更新 Homebrew Formula 的版本和两个 SHA-256；在建立最小权限
的跨仓库自动化之前，这一步由发布者在 Release 成功后显式完成。
