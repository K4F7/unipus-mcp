#!/home/box/tts-venv/bin/python
"""Local TTS → 16k mono WAV.
usage: synth.py <engine kokoro|piper> <voice> <out.wav> [speed] [sentence_pause_sec]   (text on stdin)
speed: kokoro speed factor (default 1.0). sentence_pause_sec > 0: synthesize sentence by sentence
(one model load) and join them with that much silence (#92)."""
import sys, time, subprocess, tempfile, os, re
eng, voice, out = sys.argv[1:4]
speed = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0
pause = float(sys.argv[5]) if len(sys.argv) > 5 else 0.0
text = sys.stdin.read().strip()
if not text: sys.exit("empty text")
D = os.path.dirname(os.path.abspath(__file__))
t0 = time.time()
tmp = tempfile.mktemp(suffix=".wav")
import soundfile as sf
if eng == "kokoro":
    import numpy as np
    from kokoro_onnx import Kokoro
    k = Kokoro(f"{D}/kokoro-v1.0.onnx", f"{D}/voices-v1.0.bin")
    parts = [s for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()] if pause > 0 else [text]
    chunks, sr = [], 24000
    for i, part in enumerate(parts):
        samples, sr = k.create(part, voice=voice or "af_heart", speed=speed, lang="en-us")
        if i: chunks.append(np.zeros(int(pause * sr), dtype=samples.dtype))
        chunks.append(samples)
    sf.write(tmp, np.concatenate(chunks), sr)
elif eng == "piper":
    from piper import PiperVoice
    import wave
    v = PiperVoice.load(f"{D}/{voice or 'en_US-lessac-high'}.onnx")
    with wave.open(tmp, "wb") as w:
        v.synthesize_wav(text, w)
else:
    sys.exit("unknown engine")
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", tmp, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", out], check=True)
os.unlink(tmp)
print(f"{time.time()-t0:.2f}s", file=sys.stderr)
