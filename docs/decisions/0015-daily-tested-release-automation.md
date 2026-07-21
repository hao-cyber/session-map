# ADR 0015：每日有变更时自动切割并发布 beta

> 状态：已接受
> 日期：2026-07-21

## 背景与约束

SessionMap 已有 tag 驱动的双架构构建、安装冒烟、Developer ID 签名、Apple 公证和
GitHub Release 流程，但版本 tag 与 Homebrew Formula 仍依赖发布者手工衔接。手工步骤
容易让 Release 与 tap 短暂或永久不一致，也无法满足“代码通过 CI 后按固定节奏自动形成
可安装版本”的要求。

发布自动化不能削弱现有门禁：GitHub Release 仍是 binary 唯一事实源；tag、根
`package.json` 与 CLI 版本仍须一致；任一架构、安装、签名或公证失败时不得创建 Release；
Homebrew 只能投影已成功发布的 archive。`main` 的保护规则也不能为了机器人版本提交而
绕过。

## 决策

- 每天 Asia/Shanghai 22:00 运行一次 release candidate workflow，也允许维护者手动触发。
- 只处理默认分支的精确 HEAD。该提交必须已经取得名为 `check` 的成功 CI check；workflow
  随后再次运行完整 `check:ci`，避免在版本切割与既有检查之间省略发布门禁。
- 若 HEAD 与最近 Release 记录的 source commit 相同，不创建空版本。否则在现有
  `vX.Y.Z-beta.N` 上只递增 `N`。
- 自动版本元数据提交只修改根 `package.json`，以当前 `main` HEAD 为父提交并由不可变 tag
  持有，不推入受保护的 `main`。提交用 `Release-Source` trailer 记录真实 source commit。
  因此 tag 中的 manifest、CLI 与 Release 版本一致，同时自动化无需绕过主分支保护。
- tag 推送后显式 dispatch 既有 Release workflow。这样即使 tag 由受限的
  `GITHUB_TOKEN` 创建、GitHub 为阻止递归而不产生 push workflow，发布仍会启动。
- Release 成功后才生成 Homebrew Formula。Formula 的两个 URL 和 SHA-256 直接来自本次
  Release 的 `checksums.txt`，通过仓库级只写 deploy key 推送到 `homebrew-tap`。
- 自动发布只负责 beta 序列。切换 stable、修改主次版本或改变发布频率必须显式修改契约，
  不由日期或 commit 数量机械推断。

## 数据流与唯一写者

```text
main HEAD + successful CI
          │ daily gate 再跑 check:ci
          ▼
version-only commit + immutable vX.Y.Z-beta.N tag
          │ explicit workflow dispatch
          ▼
Release workflow ──► signed/notarized GitHub Release
          │ checksums.txt
          ▼
deterministic Formula renderer ──► homebrew-tap main
```

源代码与 root manifest 决定候选内容；tag 决定版本身份；GitHub Release 是发布物唯一事实源；
Homebrew Formula 是只读派生投影。tap workflow 不构建 binary，tap 仓库也不反向修改主仓库。

## 失败、恢复与安全边界

- CI 或本地重跑门禁失败：不创建版本提交或 tag。
- tag 已推送但 dispatch 瞬时失败：下次运行识别同名未发布 tag，验证其中 manifest 后重新
  dispatch，不覆盖或移动 tag。
- 构建、安装冒烟、签名或公证失败：保留 tag 供诊断，但不创建 Release，也不更新 tap。
- Release 已成功而 tap job 失败：GitHub Release 仍是有效事实源；只重跑失败的 tap job，
  不改写 Release 资产。
- `HOMEBREW_TAP_DEPLOY_KEY` 只对应 `homebrew-tap` 一个仓库，不授予账户或主仓库写权限；
  私钥只存 GitHub Actions secret。workflow 通过 GitHub HTTPS metadata 获得 SSH host keys，
  不关闭 host verification。
- 自动化不读取或迁移 `state.json`，不接触 transcript、capability token 或用户机器。
  客户端升级仍是显式的 `brew upgrade` / 安装包操作，并最终进入同一个
  `sessionmap install` 健康检查与回滚事务。

## 备选方案与取舍

- **每次 push 立即发布**：会把中间提交变成用户版本并制造过多 Release，拒绝。
- **每天无条件发布日期版本**：没有源变化也产生噪声，且日期不能表达 beta 序列，拒绝。
- **机器人直接提交版本号到 `main`**：需要绕过 required checks 或编排自触发 PR，扩大
  权限和状态机；当前用 tag 持有的版本提交保持主分支保护。
- **长期 PAT 写 tap**：权限通常大于单仓库 deploy key，拒绝。
- **让 tap 自己抓 latest 并改写**：会使 tap 在 Release 完整性门禁之外拥有发布时序，拒绝。

## 后果与验证

正常开发只需合入并通过 CI；有新代码时，下一次日程自动形成下一 beta，并在 Release
成功后同步 Homebrew。维护者仍可手动触发 daily workflow 立即切割版本。

验证必须覆盖：无变化不发版、beta 递增、已有未发布 tag 重试、tag/package/CLI 一致、
完整 CI、双架构安装与重启、签名、公证、Release 创建，以及 Formula URL/SHA、
`brew style`、`brew audit` 和 tap push。
