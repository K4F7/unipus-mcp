# unipus-mcp

U校园AI / **U听说**（U听力 + U口语）本机 stdio MCP。

## 范围

- 目标产品：手机 App「U听力」（包名 `cn.unipus.cloud`），**不是**网页课「261英语视听说」。
- 网关线索：`https://ucloud.unipus.cn/api/uls/*`（需 JWT）；SSO：`sso.unipus.cn`。
- 登录与密钥：环境变量 / SecretSpec，**不作为 MCP 工具参数**。

## MVP（首批工具，随抓包修订）

1. `auth_status` — 是否已有可用 JWT / SSO session  
2. `list_week_progress` — 本周听力进度（如 x/5）与级别  
3. `start_listening_training` — 对应 App「开始训练」（精确 path 以抓包为准）

## 开发

- 本机 `grok build` + issue-to-main；专仓 bot：`unipus`。
- 参考笔记：路标侧 `/workspace/unipus-apk/cloud-api-map.md`（勿提交密钥）。

## License

Private use for Sein / K4F7 unless stated otherwise.
