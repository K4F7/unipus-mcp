# Agents

- 专仓施工 bot：`unipus`（本机 grok build + issue-to-main）。
- 路标只拆工单、盯进度；不在本仓直接改代码。
- 密钥：SecretSpec + SOPS + age；真值不进聊天。
- 执行训练、接入 agent 作答、处理 TTS/登录/评分异常时，读 [docs/agent-workflow.md](docs/agent-workflow.md)：环境检查、答案交接、续跑与平台结果核验。
