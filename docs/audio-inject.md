# Audio inject plan (U听力 / U口语)

## Why
跟读、口头填空、口语题都要麦克风。人工念不可扩展；系统 TTS 外放不可靠。

## Phases
1. **Device path**: find a way to present a WAV as the mic input while WebView records (loopback / virtual mic). Prove with one Pre-listening 跟读.
2. **API path (headless)**: capture `query-upload-url` + submit payload; generate TTS → upload → submit without UI.
3. Wire MCP tools: `start_listening_training`, week remaining listen+speak, later `start_speaking_training`.

## Near-term experiment
On Sein phone: try `adb shell` + existing virtual-mic apps, or Frida AudioRecord hook with a short PCM of "associate's degree".
