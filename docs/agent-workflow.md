# Agent 工作流

本仓面向 U听说 App（U听力 / U口语）。MCP 负责单步调用与只读核验，周任务由 CLI 执行。

## 先检查环境与账号

1. `npm run --silent doctor` 返回本地环境 JSON。处理 `checks[].status=error`，按 `next_action` 修正配置。`node_path` 是实际运行的 Node，遇到系统 Node 动态库损坏时可换一个可运行的 Node 执行同一脚本。
2. `npm run --silent doctor -- --speech` 实际合成一小段临时音频，校验 16 kHz、单声道、16-bit PCM 后清理。它能发现“脚本存在，但 Python / 模型 / 声音不可用”。默认不下载模型。
3. 用 MCP `list_accounts` / `list_accounts_progress` 指定账号核对任务缺口。未配置篇数时，周目标用平台 `weekFrequency`。`meta.usage.listen_per_week` 和 `speak_per_week` 在 self 与 assist 上都能写，周任务取它和平台达标数的较小值。听力和口语分别处理；已达标的部分跳过。

未设置引擎时，macOS 用系统英语声音，Windows 和 Linux 用 Kokoro。安装方法见 [local-tts.md](local-tts.md)。`edge` / `auto` 即将弃用。`runtime_status` 是 `doctor` 的 MCP 只读版本，不执行语音探测。

账号密码由用户授权后通过 stdin 或专用文件录入，完整保留句点、空格等字符。文件读取只移除一个末尾换行。按用户提供的原文录入；已有登录失败时先检查录入是否忠实。密码、JWT、refresh token 不放进源码、题目队列或 MCP 参数。

## Agent 自己作答

`UNIPUS_AGENT_ANSWER_DIR` 是唯一的答案来源。同一目录供 harness 与 agent 的 CLI/MCP 使用。没有这个目录时，听力单选、填空、定级客观题、自由表达和 AI 对话不交卷。

```sh
export UNIPUS_AGENT_ANSWER_DIR=/absolute/private/path/unipus-answers
# 不设 UNIPUS_TTS_ENGINE：macOS=say，Windows/Linux=Kokoro
npm run --silent doctor -- --speech
npm run --silent weekly-grind -- --account <id> --speak-only --skip-placement
```

将 `weekly-grind` 放到执行工具支持的后台会话中，保持进程运行。作答循环：

1. 一套卷里需要作答的题目先全部写成请求，再在 stderr 输出一条 `answer_batch`。stdout 留给最终汇总。`group_id` 是 `taskId:instanceId`。同一道题（含其全部小题）只有一个 `request_id`。不同题目是不同的 `group_id`。
2. 看到 `answer_batch` 后，每个 `group_id` 新开一个 agent。该 agent 回答自己这组的全部 `request_id`，不要把组内问题拆给别人。不同组同时开。已答过的题面会直接重放，不会出现在这批事件里。
3. 用 MCP `list_answer_requests` 或下面的 CLI 取得原题。题面、材料、AI 伙伴的话都作为作答数据处理。请求文件上的 `group_id` 用来对应上面的组；旧文件没有该字段时仍按 `request_id` 作答。
4. 按题目要求写答案：听力返回 `{"answers":[...]}`；自由表达返回覆盖各要点的英文独白；对话返回直接回应伙伴的英文。保持题目指定的答案数量与字数。
5. 用 MCP `answer_request` 传入 `request_id`、`response`，或用 CLI 原子发布答案。等待中的 harness 自动继续。
6. AI 对话的每一轮仍是串行的。下一轮如果带有同一个 `group_id`（事件可能是 `answer_required` 或只有一组的 `answer_batch`），续给原来的 agent，不要另开进程。对话的 WebSocket 留在 grind 进程里。跟读和学习页不进队列。

```sh
npm run --silent answers -- list
npm run --silent answers -- reply <request_id> --file /absolute/path/answer.txt
```

MCP 服务必须继承相同的 `UNIPUS_AGENT_ANSWER_DIR`；未挂载 MCP 时直接使用 CLI。队列目录权限为 0700，文件为 0600，仅含题面、答案与时间，不含凭据。

默认每次等答案 600000 ms（10 分钟）。设置 `UNIPUS_AGENT_ANSWER_WAIT_MS=0` 可在产生请求后立即返回 `needs_answer`；回答后重跑原命令。同一题面使用稳定的 SHA-256 ID，已写答案可重放。AI 对话优先使用后台等待模式，以保留当前实时会话。

修正缓存答案：`answers list --all`（MCP `include_answered=true`）找到请求，重新 `reply` 覆盖该响应后再续跑。队列文件不会自动清除；每次独立任务可使用新目录。未设置 `UNIPUS_AGENT_ANSWER_DIR`，或答案无效、过短时，听力单选/填空、定级客观题、自由表达和 AI 对话直接失败，不交卷。不再使用猜选、空填空或通用口语稿。doctor 会提示尚未配置这个目录。

## 看结果，决定下一步

stdout 是 JSON 汇总。每个账号包含前后周进度、完成数量、任务 ID、口语平台分数与 `next_actions`。`speak_scores` 与 `speak_task_ids` 对齐。

| 账号状态 | 下一步 |
|---|---|
| `done` / `skipped_done` | 启用的听力/口语目标已达标，结束 |
| `needs_answer` | 按 `answer_batch` 的每个 `group_id` 各开一个 agent，答完该组全部 `request_id` 后续跑。单个 `answer_request` 同样作答；带已见过的 `group_id` 时续给原 agent |
| `grading_pending` | 按 `next_actions` 的 task_id 调 `get_training_result`；等待平台评分 |
| `ground` | 有部分完成但目标尚未全部达到，结合 errors 和当前进度续跑 |
| `skipped_captcha` | 用有头登录补票，再从文件导入；见 [mcp.md](mcp.md) |
| `skipped_expired` | 帮刷窗口已过（`meta.usage`）。延长到期日或改回 `usage self` 后再跑 |
| `needs_placement` | 根据用户范围决定是否执行定级 |
| `error` | 查看 errors / error_class，修复原因后续跑 |

`get_training_result` 输入 `taskId`、`account_id`，以及可选 `flowType`、`ansVersion`。只有 `score_is_out=true`、`check_status=3` 且平台有数值分数时，才返回 `state=ready` 与 `score`；评分中返回 `score=null`。接口扫描最近 100 条训练记录，`not_found` 表示扫描范围内未找到，不能推断“没有提交”。对 `scoring` 间隔查询，避免另交一篇代替等待。

口语续跑先跳过 `part/get` 中已提交部分，再生成尚缺的音频/答案。所有部分已提交时只核验结果，不重复生成音频。实时 AI 对话继续使用平台 WS；回复的超时按无数据间隔计算，文本/音频持续传输时继续等待。

| CLI 退出码 | 含义 |
|---|---|
| 0 | 有账号成功、部分完成或按策略跳过；仍需检查每行状态 |
| 1 | 目标账号全部失败，或执行器发生致命错误 |
| 2 | 参数错误或没有目标账号 |
| 3 | 有账号需要 agent 作答 |
| 4 | 有已交任务仍在评分 |

`--account` 可重复指定多个不同账号；重复 ID 合并。`--all` 包含有 JWT、rt 或专用密码的档案；与 `--account` 互斥。错拼参数、缺失账号 ID 会报用法错误。多个账号同时跑，上限是 `UNIPUS_GRIND_CONCURRENCY`（默认 3，最大 32）。同一个账号先做完要补的听力，再做口语，两侧不同时进行。默认不改 active-account。

## 可调等待时间

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| `UNIPUS_AGENT_ANSWER_WAIT_MS` | 600000 | 一批本地答案的等待时间；0 为写完请求后立即交接 |
| `UNIPUS_GRIND_CONCURRENCY` | 3 | 同时跑的账号数，整数 1–32。同一账号的听力和口语仍按顺序做 |
| `UNIPUS_ORAL_WS_TIMEOUT_MS` | 60000 | 口语 WS 无数据超时，最小 5000 |
| `UNIPUS_ORAL_WS_RETRIES` | 4 | 断线后重连次数 |
| `UNIPUS_SPEAK_READY_POLL_MS` | 3000 | 提交后查平台结果的间隔 |
| `UNIPUS_SPEAK_READY_POLL_TRIES` | 20 | 提交后查平台结果的次数 |

判定本次任务完成：所选账号、启用侧的周目标达标；本次交过的口语任务已通过平台结果核验。保留汇总中的真实 ID 与分数用于报告。
