/*
 * AudioWorklet：把标签页音频处理成 16kHz 单声道 PCM(Int16)，每 1024 个采样点（64ms）打包一次。
 *
 * 降采样用「区间平均」而不是直接抽样：48kHz→16kHz 时每 3 个输入采样取平均，
 * 相当于一个简单的抗混叠低通，比直接丢点干净得多（直接丢点会把高频折叠进人声频段）。
 *
 * 放在 AudioWorklet 里做是因为 process() 跑在音频线程，不受页面主线程卡顿影响。
 */

const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 1024; // 64ms @16k

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.phase = 0;      // 降采样相位累加器
    this.acc = 0;        // 当前输出采样点对应的输入累加
    this.count = 0;      // 累加的输入采样个数
    this.out = new Int16Array(CHUNK_SAMPLES);
    this.outLen = 0;
    this.ratio = TARGET_RATE / sampleRate;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const left = input[0];
    if (!left) return true;
    const right = input.length > 1 ? input[1] : null;
    const n = left.length;

    for (let i = 0; i < n; i++) {
      let s = right ? (left[i] + right[i]) * 0.5 : left[i];
      this.acc += s;
      this.count++;
      this.phase += this.ratio;

      if (this.phase >= 1) {
        this.phase -= Math.floor(this.phase);
        let v = this.count > 0 ? this.acc / this.count : 0;
        if (v > 1) v = 1;
        else if (v < -1) v = -1;
        this.out[this.outLen++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        this.acc = 0;
        this.count = 0;

        if (this.outLen === CHUNK_SAMPLES) {
          const buf = this.out.buffer.slice(0); // 拷一份再转移，避免复用同一块内存
          this.port.postMessage(buf, [buf]);
          this.outLen = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("vst-pcm-capture", PcmCaptureProcessor);
