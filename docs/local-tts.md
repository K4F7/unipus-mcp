# 本地 TTS（#66）

口语交卷默认用本地 **Kokoro**（82M，ONNX，CPU），不走 Edge/云 TTS，也不回退 flite；合成失败直接报错、不交卷。

## 安装（box）
```bash
python3 -m venv ~/tts-venv && ~/tts-venv/bin/pip install kokoro-onnx soundfile piper-tts
mkdir -p ~/tts-local && cd ~/tts-local
curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
cp <repo>/scripts/local-tts.py ~/tts-local/synth.py && chmod +x ~/tts-local/synth.py
# 可选 Piper：en_US-lessac-high.onnx(+.json) 放同目录
```

## 环境变量
- `UNIPUS_TTS_ENGINE`：未设置时按平台默认——macOS 用系统 `say`（固定 `say -o <文件>` 写文件后 ffmpeg 转 16k 单声道 16bit WAV，绝不外放），其他平台用 `kokoro`；可显式设 `kokoro` | `piper` | `say`；旧 `edge`/`flite`/`auto` 仅显式指定时生效
- `UNIPUS_SAY_VOICE`：macOS say 音色（默认 `Samantha`）；`UNIPUS_FFMPEG_BIN`：ffmpeg 路径（默认 PATH 上的 `ffmpeg`，单次 60s 强杀）
- `UNIPUS_LOCAL_TTS_BIN`：脚本路径，默认 `~/tts-local/synth.py`
- 脚本参数：`synth.py <engine> <voice> <out.wav> [speed] [sentence_pause_sec]`（文本走 stdin）。`speed`/`pause` 只在自由表达时传入（`UNIPUS_FREE_TALK_TTS_SPEED`，默认 0.85；句间停顿 0.5s，录音不足 `UNIPUS_FREE_TALK_MIN_SEC` 时自动加长到 1.2s）。旧版脚本会忽略这两个参数导致自由表达过短被拒交——升级仓库后请重新执行上面的 `cp`，`scripts/doctor.ts` 会检查。
- `UNIPUS_KOKORO_VOICE`（默认 `af_heart`）/ `UNIPUS_PIPER_VOICE`

## 选型
同一段 60 词 Clio 打分：Kokoro af_heart 94（fluency 85）、Piper lessac-high 94（86）、Edge 94（87）、flite 91（75）。Clio 对神经 TTS 饱和；Kokoro 韵律最自然，选作默认。
