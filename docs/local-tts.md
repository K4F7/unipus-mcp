# 本地 TTS（#66）

未设置 `UNIPUS_TTS_ENGINE` 时，macOS 固定用系统语音 `say`，Windows 和 Linux 固定用本地 **Kokoro**（82M，ONNX，CPU）。合成失败直接报错，保留任务供恢复。

Edge TTS（`UNIPUS_TTS_ENGINE=edge` 或 `auto`）即将弃用，只保留给还显式指定它的环境。新的训练不要再用。

## macOS 系统语音

```sh
export UNIPUS_TTS_ENGINE=say
export UNIPUS_SAY_VOICE=Samantha
npm run --silent doctor -- --speech
```

原生 `/usr/bin/say` 静默写 AIFF，ffmpeg 转成 16 kHz 单声道 16-bit PCM WAV，不需要临时 shell 包装或下载 Kokoro。声音必须已安装；自检合成会检查声音可用性并清理临时音频。

## 安装（box）
```bash
python3 -m venv ~/tts-venv && ~/tts-venv/bin/pip install kokoro-onnx soundfile piper-tts
mkdir -p ~/tts-local && cd ~/tts-local
curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
cp <repo>/scripts/local-tts.py ~/tts-local/synth.py && chmod +x ~/tts-local/synth.py
# 将 synth.py 首行 shebang 改成实际虚拟环境 Python 的绝对路径
# 可选 Piper：en_US-lessac-high.onnx(+.json) 放同目录
```

## 环境变量
- `UNIPUS_TTS_ENGINE`：不设时 macOS 为 `say`，Windows/Linux 为 `kokoro`。显式值：`kokoro` | `piper` | `say`（仅 macOS）| `flite`。`edge` 与 `auto` 即将弃用。
- `UNIPUS_LOCAL_TTS_BIN`：脚本路径，默认 `~/tts-local/synth.py`
- `UNIPUS_KOKORO_VOICE`（默认 `af_heart`）/ `UNIPUS_PIPER_VOICE`
- `UNIPUS_SAY_VOICE`：系统声音，默认 `Samantha`
- `UNIPUS_FFMPEG_BIN`：ffmpeg 路径；兼容旧 `UNIPUS_FFMPEG`

`npm run --silent doctor` 检查命令、脚本和 shebang；增加 `-- --speech` 会真实合成并核对音频格式。显式选择 Edge 时，语音探测会访问该上游。

## 选型
同一段 60 词 Clio 打分：Kokoro af_heart 94（fluency 85）、Piper lessac-high 94（86）、Edge 94（87）、flite 91（75）。Clio 对神经 TTS 饱和；Kokoro 韵律最自然，选作默认。
