// Audio in Gemini Live formats: the mic goes up as 16 kHz PCM16, answers come back as 24 kHz PCM16 (base64).

export function f32ToPcm16B64(f32) {
  const pcm = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) pcm[i] = Math.max(-1, Math.min(1, f32[i])) * 32767;
  const bytes = new Uint8Array(pcm.buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function pcm16B64ToF32(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const pcm = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
  const f32 = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 32768;
  return f32;
}

export function rms(f32) {
  if (!f32.length) return 0;
  let sum = 0;
  for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
  return Math.sqrt(sum / f32.length);
}

const OUT_RATE = 24000;

// Plays answer chunks back to back and reports how loud the output is (drives the eye while it speaks).
export class Player {
  constructor(ctx) {
    this.ctx = ctx;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.connect(ctx.destination);
    this.buf = new Float32Array(this.analyser.fftSize);
    this.sources = [];
    this.next = 0;
    this.startedAt = null; // ctx time the current run of audio started
  }

  play(b64) {
    const data = pcm16B64ToF32(b64);
    if (!data.length) return;
    const buffer = this.ctx.createBuffer(1, data.length, OUT_RATE);
    buffer.getChannelData(0).set(data);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.analyser);
    const now = this.ctx.currentTime;
    if (!this.sources.length) { this.next = Math.max(this.next, now + 0.05); this.startedAt = this.next; }
    src.start(this.next);
    this.next += buffer.duration;
    this.sources.push(src);
    src.onended = () => {
      this.sources = this.sources.filter((x) => x !== src);
      if (!this.sources.length) this.startedAt = null;
    };
  }

  stop() {
    for (const s of this.sources) { s.onended = null; try { s.stop(); } catch { /* not started */ } }
    this.sources = [];
    this.next = 0;
    this.startedAt = null;
  }

  get playing() { return this.sources.length > 0; }

  // How long the current answer has been audible, in ms (0 when silent or not yet started).
  get playedMs() {
    if (this.startedAt === null) return 0;
    return Math.max(0, (this.ctx.currentTime - this.startedAt) * 1000);
  }

  get level() {
    if (!this.playing) return 0;
    this.analyser.getFloatTimeDomainData(this.buf);
    return Math.min(1, rms(this.buf) * 4);
  }
}

// Mic audio arrives at the device rate (often 48 kHz); Gemini wants 16 kHz. Averages each window of samples.
export function downsampleTo16k(f32, rate) {
  if (rate === 16000) return f32;
  const ratio = rate / 16000;
  const out = new Float32Array(Math.floor(f32.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio), end = Math.min(f32.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += f32[j];
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}
