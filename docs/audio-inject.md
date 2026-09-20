# Audio inject plan (U听力 / U口语)

## Why
跟读、口头填空、口语题都要麦克风。人工念不可扩展；系统 TTS 弹「打开方式」不可靠。

## Status (2026-09-21, Sein 小米 24094RAD4C / alice)

### Proven — acoustic path（设备旁路）
- App：`cn.unipus.cloud` WebView；口语「范例学习」Step 2 跟读。
- 录音：`AudioRecord` **MIC / 1ch / 16 kHz / PCM16**。
- 无 root、无 Frida。
- **点击目标**：麦克风图标中心约 `(539, 880)`（1080×2400）。点「录音」文字（y≈956）**不会**开录。
- 录音中文案：「录音中 点击提交」；再点同一图标提交。
- 得分后：「重录」文字 `(539, 985)` → 再点麦克风开录。
- **注入**：手机靠近 Mac 扬声器，录音期间 `afplay` TTS → 提交。
  - 实测句子 `Hey, future me!` → **76 分**。
- 脚本草稿（alice）：`~/unipus-phone/inject-one.sh`

### Not yet
- 虚拟麦 / Frida `AudioRecord.read` 喂 PCM（需 root 或 gadget）。
- 无头：`query-upload-url` + 上传 + 提交（短时 PCAPdroid TLS 抓包，超时立刻停 VPN）。

## Phases
1. **Device path（进行中）**: 声学旁路已验证跟读可得分；收多句脚本。
2. **API path (headless)**: 抓 `query-upload-url` + submit；TTS → upload → submit。
3. Wire MCP：`start_listening_training`（已合入）、周进度听+口、`start_speaking_training`。

## Ops
- 只在 **alice** 上 `adb`；box 上的 emulator / mitmdump / adb server 保持关闭，避免抢设备。
- PCAPdroid VPN（尤其 TLS 解密）会弄挂 WebView / 提交超时 → **短时开抓，异常立刻停 VPN**。


## Status 2026-09-21 (silent path)

- Acoustic speaker→mic: works (e.g. 76) but **forbidden** (no playback).
- Device: no root; Frida unavailable; `tinymix` cannot open mixer.
- PCAPdroid Control API + mitm addon: VPN starts; **TLS decrypt yields no HTTP payloads** (Connections → HTTP 请求 = 空). Likely **cert pinning** in App/WebView. SNI only: `uadaptive.unipus.cn`, `speech.unipus.cn`, `clio-audios.unipus.cn`, `up-z1.qiniup.com`.
- SPA static: `POST /api/uls/user/answer/query-upload-url` → Qiniu form upload (`token`,`key`,`file`) → `submitAnswer`.
- JWT via SSO CLI (`scripts/sso-login.ts`) + MCP `upload_answer_audio` (query-upload-url → Qiniu) **implemented 2026-09-21**.
- Done: MCP `speak_and_submit` (Edge TTS → upload → submit_answer). Speak week-progress: GET /api/uls/user/activation/status (speakTrialUsed/trialUsageLimit).
