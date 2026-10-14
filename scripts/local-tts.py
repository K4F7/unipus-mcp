#!/home/box/tts-venv/bin/python
"""Local TTS → 16k mono WAV. usage: synth.py <engine kokoro|piper> <voice> <out.wav> (text on stdin)"""
import sys, time, subprocess, tempfile, os
eng, voice, out = sys.argv[1:4]
text = sys.stdin.read().strip()
if not text: sys.exit("empty text")
D = os.path.dirname(os.path.abspath(__file__))
t0 = time.time()
tmp = tempfile.mktemp(suffix=".wav")
import soundfile as sf
if eng == "kokoro":
    from kokoro_onnx import Kokoro
    k = Kokoro(f"{D}/kokoro-v1.0.onnx", f"{D}/voices-v1.0.bin")
    samples, sr = k.create(text, voice=voice or "af_heart", speed=1.0, lang="en-us")
    sf.write(tmp, samples, sr)
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
