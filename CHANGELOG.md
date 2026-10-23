# Changelog

## v0.2.0

- 插件卡片名称固定为 `dsh-replay`，不再随语言显示为“回言”或 `Re:Play`；输入历史 / Input History、消息重试 / Prompt Replay 组件标题保持中英文国际化。
- npm 安装包采用作用域名称 `@bxzy/dsh-replay`，仓库仍为 `AutumnNazi/dsh-replay`；无作用域 npm 包 `dsh-replay` 属于其他维护者，不是本项目的安装包。
- 使用直接 npm 发布源支持当前 DSH 管理器原生查询 `latest`、检测版本差异并由用户点击确认更新；GitHub/Git 来源仍为手动源码渠道，旧安装需用户手动停用卸载后改装 npm 包。不新增自建更新器、更新 API、后台检查或设置页。
- 补充更新后的启停复查说明：当前网关更新时传入 `enabled: true`，不保证保留整个插件的停用状态；两个独立原生组件及中英文字典保留。
- Release 交付使用 `bxzy-dsh-replay-0.2.0.tgz` 与 `SHA256SUMS.txt`；发布辅助脚本根据当前包名、版本和已验包生成 SHA-256 校验文件，不自行打包、安装或发布，不能替代归档内容与来源核验。

## v0.1.0 — 初始源码交付（initial source delivery）

- 此阶段为初始源码交付记录，不表示已有 GitHub tag/Release 或 npm 发布。
- 提供按会话隔离的输入历史回翻与追加式用户消息重试两个独立原生组件。
- 支持中文与英文界面，组件语言跟随 DSH。
