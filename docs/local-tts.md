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
- `UNIPUS_TTS_ENGINE`：`kokoro`（默认）| `piper` | 旧 `edge`/`flite`/`auto`（仅显式指定时）
- `UNIPUS_LOCAL_TTS_BIN`：脚本路径，默认 `~/tts-local/synth.py`
- `UNIPUS_KOKORO_VOICE`（默认 `af_heart`）/ `UNIPUS_PIPER_VOICE`

## 选型
同一段 60 词 Clio 打分：Kokoro af_heart 94（fluency 85）、Piper lessac-high 94（86）、Edge 94（87）、flite 91（75）。Clio 对神经 TTS 饱和；Kokoro 韵律最自然，选作默认。
