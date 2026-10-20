# 开发与发布

## 环境与检查

需要 Node.js `>=22.19.0` 和项目指定的 pnpm（见 `package.json` 的 `packageManager`）。

```sh
pnpm install --frozen-lockfile
pnpm format
pnpm check
pnpm pack --pack-destination ..
```

`pnpm check` 包括 strict 类型检查、Prettier 格式检查、自动测试、构建及打包资源和浏览器脚本检查。单独运行测试可使用 `pnpm test`。

测试覆盖 YAML 保留、Git/非 Git 根目录、导入与去重、路径约束、删除恢复、并发原子写入、配置损坏保护、MCP 配置校验、生命周期和 RPC envelope。各版本的实测范围见 [验证记录](VALIDATION.md)。

## 开发约定

- 源码、浏览器入口、构建脚本和测试使用 TypeScript，开启 strict 类型检查。
- 运行依赖复用 Harness；前端使用宿主原生组件与设计令牌。构建输出至 `dist/`，浏览器经典脚本由构建步骤验证并生成。
- `.editorconfig` 规定两空格缩进、LF 换行和文件末尾换行；Prettier 使用 100 字符行宽及统一括号、引号规则。
- 提交 `pnpm-lock.yaml`，不提交 `node_modules`、`dist` 或 npm 锁文件。

## 宿主兼容

- 使用官方 `Connection.fetch.register`，客户端通过 `connection.rpc.call` 发起请求，复用认证、请求关联和 Desktop 通道。
- 使用宿主自带的 MCP 插件与 Cordis，避免安装第二份核心运行时或 React。
- 不依赖 `webServer`、客户端旧版 `workspaces` 服务、固定 localhost 端口或 Electron 私有模块。
- `platform: web` 是 Harness 两端共用的浏览器模块标记，Desktop 同样使用该界面。
- `engines.dsh` 为 `>=0.2.1-rc.2 <0.3.0-0`，确保宿主提供所需原生基础组件。声明范围不等于每个版本都已实测，实际验证范围以 [验证记录](VALIDATION.md) 为准。

## GitHub 自动构建

[构建工作流](.github/workflows/build.yml) 在推送、Pull Request 和手动触发时运行，使用 Node.js 24 及 `package.json` 指定版本的 pnpm。流程安装锁定依赖，通过 `pnpm pack` 的 `prepack` 完成全部检查，再上传 `plugin-package` artifact，保留 14 天。

登录 GitHub，在成功运行的 Actions 页面下载 artifact，解压后按 [本地安装说明](README.md#下载安装) 安装 `.tgz`。构建包位于 `artifacts/`，不提交到 Git；此工作流不发布 npm 包。

## 发布到 npm

在源码目录执行，需要支持浏览器登录的 npm CLI，且 npm 账号具有该包的发布权限。先安装依赖，并将 `package.json` 的 `version` 更新为尚未发布的新版本；同一版本不能重复发布。

试运行只检查、构建、打包和预览，不登录或上传：

```sh
pnpm release:dry-run
```

正式发布：

```sh
pnpm release
```

脚本依次执行：

1. 通过 `prepack` 运行 `pnpm check`。
2. 生成安装包，预览将发布的内容。
3. 运行 `npm login --auth-type=web`，按终端提示在浏览器中完成登录。
4. 使用 `npm whoami` 确认身份，再由 pnpm 将预览过的同一个包公开发布到 `https://registry.npmjs.org/`。
5. 按 npm 提示完成发布身份验证或 2FA，等待扫描及版本公开。
6. 检查精确版本元数据，下载实际安装包并核对 SHA-512，通过后才报告发布成功。

检查失败或取消登录会停止流程并返回非零退出码。脚本不保存密码或验证码，登录凭据由 npm CLI 管理。

**上传被接受但等待超时时，先检查 npm 版本页面或待发布状态，不要再次上传同一版本。** 后续检查不会自动重复发布。

发布成功后可查询 npm 信息，再按 [README](README.md#安装) 的安装与升级说明分别安装到 Web 和 Desktop 验证：

```sh
pnpm view dsh-skills-mcp-universal@latest version dist.integrity --registry=https://registry.npmjs.org/
```

参考：[npm login](https://docs.npmjs.com/cli/v11/commands/npm-login/)、[pnpm publish](https://pnpm.io/cli/publish)、[npm 发布扫描说明](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/)。
