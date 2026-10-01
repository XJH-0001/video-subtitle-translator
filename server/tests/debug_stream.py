"""临时调试脚本：观察流式断句内部状态。"""
import sys, wave
from pathlib import Path
import numpy as np

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

from asr import SAMPLE_RATE, StreamSession, WhisperEngine, EnergyVAD
from config import load_settings
from selftest import read_wav_16k

CHUNK = 1024

settings = load_settings()
settings.model = "tiny"
engine = WhisperEngine(settings)
engine.load()
session = StreamSession(engine, settings)

orig_fin = StreamSession._finalize
def patched(self, *, cut):
    a = self._segment_audio()
    print(f"   >> finalize cut={cut} seg_audio={a.size/SAMPLE_RATE:.2f}s "
          f"speech_ratio={float(self.vad.speech_flags(a, adapt=False).mean()):.2f} "
          f"silence_ms={self.silence_run_ms}")
    ev = orig_fin(self, cut=cut)
    print(f"   >> finalize -> {len(ev)} event(s)")
    return ev
StreamSession._finalize = patched

orig_open = StreamSession._open_segment
def patched_open(self):
    orig_open(self)
    print(f"   >> open segment at {self.seg_start_sample/SAMPLE_RATE:.2f}s")
StreamSession._open_segment = patched_open

audio = read_wav_16k(HERE / "tests" / "sample_en.wav")
print(f"audio {audio.size/SAMPLE_RATE:.2f}s, vad thr will adapt from {session.vad.noise}")

idx = 0
t = 0.0
while idx < audio.size:
    block = audio[idx:idx + CHUNK]
    idx += CHUNK
    t += block.size / SAMPLE_RATE
    pcm = np.clip(block * 32768.0, -32768, 32767).astype(np.int16)
    session.feed(pcm)
    for ev in session.poll_events():
        kind = "speech" if ev.get("type") == "speech" else ("FINAL" if ev["final"] else "part ")
        print(f"[{t:6.2f}s] {kind} id={ev['id']} t0={ev['t0']:6.2f} {ev['source']}")
    if abs(t - round(t, 1)) < 0.033 and int(t * 10) % 5 == 0:
        print(f"    .. state@ {t:5.2f}s open={session.open_seg} "
              f"sp={session.speech_run_ms} si={session.silence_run_ms} "
              f"buf={session.buf.size/SAMPLE_RATE:.2f}s")

print("--- flush ---")
session.flush()
session.wait_idle(timeout=120)
for ev in session.poll_events():
    kind = "speech" if ev.get("type") == "speech" else ("FINAL" if ev["final"] else "part ")
    print(f"{kind} id={ev['id']} {ev['source']}")
session.close()
print("stats:", session.stats)
