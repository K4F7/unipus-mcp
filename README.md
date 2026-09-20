# unipus-mcp

U校园AI / **U听说**（U听力 + U口语）本机 stdio MCP。

## 范围

- 目标产品：手机 App「U听力」（包名 `cn.unipus.cloud`），**不是**网页课「261英语视听说」。
- 网关线索：`https://ucloud.unipus.cn/api/uls/*`（需 JWT）；SSO：`sso.unipus.cn`。
- 登录与密钥：环境变量 / CLI / SecretSpec，**不作为 MCP 工具参数**。

## MVP 工具

1. `auth_status` — 是否已有可用 JWT / SSO session
2. `list_week_progress` — 本周听力进度（如 x/5）与级别
3. `start_listening_training` — 对应 App「开始训练」（精确 path 以抓包为准）

当前为骨架：工具可列出；占位实现返回稳定 JSON 错误（`auth_required` / `not_implemented`）。真实 HTTP 见后续 issue。

## 开发

```sh
npm ci
npm run typecheck
npm run build
npm test
npm start --silent   # stdio MCP；勿关 stdin
```

## 挂到 Grok Bot（AddMcpServer 无 cwd）

必须用**绝对路径** launcher。详见 [docs/mcp.md](docs/mcp.md)。

推荐：

```json
{
  "command": "/ABS/PATH/TO/unipus-mcp/scripts/run-mcp.sh",
  "args": []
}
```

或：

```json
{
  "command": "npm",
  "args": ["start", "--silent", "--prefix", "/ABS/PATH/TO/unipus-mcp"]
}
```

本机仓库路径示例：`/workspace/unipus-mcp`。

## License

Private use for Sein / K4F7 unless stated otherwise.
