r"""测量流式解码的真实开销：每次解码的音频长度 vs 耗时。"""
import sys, time, wave
from pathlib import Path
import numpy as np

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))
from config import load_settings, ensure_hf_endpoint
from selftest import read_wav_16k

ensure_hf_endpoint()
from faster_whisper import WhisperModel

model_name = sys.argv[1] if len(sys.argv) > 1 else "small"
threads = int(sys.argv[2]) if len(sys.argv) > 2 else 12

print(f"模型={model_name} 线程={threads}")
m = WhisperModel(model_name, device="cpu", compute_type="int8",
                 cpu_threads=threads, num_workers=1, download_root=str(HERE / "models"))

audio = read_wav_16k(HERE / "tests" / "sample_en.wav")

# 预热一次，排除惰性初始化
list(m.transcribe(audio[:16000], language="en", beam_size=1, without_timestamps=True)[0])

print(f"\n{'输入长度':>8} {'language=en':>14} {'language=None':>16} {'detect_language':>17}")
for secs in (0.5, 1.0, 2.0, 3.0, 5.0, 8.0, 12.0, 21.0):
    clip = audio[: int(secs * 16000)]

    t0 = time.time()
    list(m.transcribe(clip, language="en", beam_size=1, without_timestamps=True,
                      condition_on_previous_text=False, temperature=0.0,
                      no_speech_threshold=0.6, log_prob_threshold=-1.0,
                      compression_ratio_threshold=2.4, vad_filter=False)[0])
    t_en = time.time() - t0

    t0 = time.time()
    list(m.transcribe(clip, language=None, beam_size=1, without_timestamps=True,
                      condition_on_previous_text=False, temperature=0.0,
                      no_speech_threshold=0.6, log_prob_threshold=-1.0,
                      compression_ratio_threshold=2.4, vad_filter=False)[0])
    t_auto = time.time() - t0

    t0 = time.time()
    try:
        m.detect_language(clip)
    except Exception as e:  # noqa: BLE001
        print("detect_language 失败", e)
    t_detect = time.time() - t0

    print(f"{secs:>7.1f}s {t_en:>13.2f}s {t_auto:>15.2f}s {t_detect:>16.2f}s"
          f"   RTF(en)={t_en/max(secs,0.01):.2f}")
