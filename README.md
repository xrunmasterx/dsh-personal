# DSH Personal

[English](README.en.md)

基于 DeepSeek Harness 的个人工作台：任务与甘特图、支持截图的任务说明、原生 Agent 聊天、Codex / Cursor 对话归档、代码进展、每日 / 每周复盘、单据与调查、个人画像。

## 安装

需要 **Node.js 24+、pnpm 10.32.1**。首版固定兼容 **DSH 0.1.6-alpha.1**，暂不兼容 0.2。

```sh
git clone https://github.com/xrunmasterx/dsh-personal.git
cd dsh-personal
pnpm install --frozen-lockfile
pnpm build
node scripts/install.mjs
node scripts/start.mjs
```

安装过程自动下载版本锁定的官方 DSH，无需原开发者的 DSH 源码、模型密钥或数据。创建独立 `personal` 配置，数据默认位于 `~/.dsh-personal`，保留其他 DSH 安装和配置。请勿移动或删除源码目录；移动后需重新安装链接。

安装与启动均可指定 `--home <绝对路径>`。测试实例可用 `node scripts/start.mjs --home <测试目录> --port 3082 --no-open`，避免与日常实例共用数据目录。服务仅绑定本机。

Windows 安装好 Node、pnpm 和 PowerShell 7 后，也可以双击 `Open-Personal.cmd`：首次安装构建，之后有本地代码变化时先更新再打开。构建在 `.local/launcher/<端口>/release-*` 独立目录进行，不覆盖正在使用的依赖和界面。聊天、归档、代码分析、复盘或调查仍在运行时会推迟切换；配置安装或新服务启动失败会恢复旧配置与旧版本。启动成功后保留当前和上一运行版本，其余构建缓存自动清理。不要单独移动或删除这些运行目录。其他平台使用上面的 Node 启动命令。

模型密钥在原生 DSH 设置中配置；任务润色、归档等分析模型也应在设置中选择。TAPD、CrashSight、工蜂及本地 Codex CLI 属于可选集成，需使用者自己的权限、配置和本地环境。

## 原有数据迁移

先停止旧工作台并备份完整 DSH 数据目录。备份包含凭据和工作记录，应保存在私有位置。

```sh
node scripts/migrate.mjs --from <旧数据目录> --to <不存在的新目录>
node scripts/install.mjs --home <新目录>
node scripts/start.mjs --home <新目录>
```

迁移不修改原目录。脚本复制并校验每个文件，保留任务、截图、完整会话、归档、代码摘要、复盘、配置和凭据。旧 Personal 专用会话元数据会被标记为可选事件，内容、序号、时间戳均保留；模型问答正文不修改。未知 Personal 事件会中止迁移，避免误处理。

安装时会将旧 `web` 配置中的 Personal Host 设置导入空白的 `personal` 配置，并保留数据目录在旧 home 下的相对位置。目录位于旧 home 外、或使用无法确认的自定义表达式时会中止导入，需要先另行复制并显式配置，避免只迁移记录却遗漏文件。已有自定义 `personal` 配置不会被覆盖。历史调查证据按当前任务目录读取并校验哈希，无需访问旧绝对路径。原目录可用于回退；迁移后的新记录不会反向同步到原目录。

## 拆分方式与兼容范围

- `packages/personal`：插件组合与安装入口。
- `packages/host`：业务状态、采集、分析、Agent 工具。
- `packages/api`：类型化远程调用及下载。
- `packages/client`：工作台外框和业务页面，保留原生聊天、工具、审批、模型设置及主题。

四个包一起发布，业务数据名称及 ID 不随 npm 包名变化。新会话关联与辅助模型审计使用插件自己的存储，不要求修改 DSH 核心事件名单。

为保留“今天想推进什么？”欢迎文案，安装时通过 `pnpm` 应用 [两行文案补丁](patches/conversation-welcome-0.1.6.patch)。它只修改官方聊天组件的中英文欢迎文字，不维护聊天组件分叉。另一个 [JSON 存储补丁](patches/storage-json-0.1.6.patch) 限制启动时的文件读取并发，并明确报出文件句柄耗尽错误，防止大量历史记录在 Windows 上被误当成不存在。独立构建还有一个 SDK 生成器兼容适配，仅作用于临时构建工具。升级 DSH 时需复核这些适配。

本仓库使用随仓库安装的版本锁定 DSH 启动，不直接复用任意外部 CLI。这样可确保欢迎文案和已验收的依赖一致。同事现有 DSH 和数据无需被替换；业务迁移到其他 DSH 版本前，应先在独立数据副本中验证。

## 更新与备份

备份数据、停止工作台，更新代码后重新执行安装依赖、构建、安装插件、启动。DSH 升级单独处理，不与业务更新混在一起。

Windows 一键入口可在更新本地代码后直接运行；它不会自动拉取远端 Git 提交。`.local/launcher` 中的配置回退副本只用于恢复安装链接，不是工作数据备份。业务数据始终位于所选 home。使用同一端口时不能切换到另一个 home；请为测试实例指定独立的 home 和端口。默认源码工作区使用稳定的仓库目录，也可设置 `PERSONAL_SOURCE_ROOT` 指向自己的项目。

仓库只备份代码。任务、聊天、图片、报告、代码 diff、凭据和本地配置均不应上传到此公开仓库，需要独立备份数据目录。

## 开发验证

```sh
pnpm build
pnpm test
node scripts/smoke.mjs
node scripts/check-public.mjs
```

测试覆盖业务逻辑、UI 交互、数据迁移、会话压缩帧、更新回退和欢迎文案兼容。smoke 检查在无开发者凭据的独立 home 中安装并启动官方 DSH，验证网页和 Personal 业务接口就绪；Windows 与 Linux CI 都执行。可选企业服务的真实访问取决于使用者的权限；离线测试通过不代表这些服务可访问。

MIT 许可证，保留原作者及依赖的许可证声明。
