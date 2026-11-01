// Microphone capture, voice-activity detection (VAD) and simple voice "fingerprints".
//
// Audio is downsampled to 16 kHz mono (what Whisper expects), cut into utterances
// whenever the speaker pauses, and each utterance gets a voiceprint (pitch +
// averaged MFCCs) so we can tell speakers apart and estimate their voice gender.

export const SAMPLE_RATE = 16000;
const FRAME = 480; // 30 ms @ 16 kHz
const FRAME_MS = 30;
const PREROLL_FRAMES = 10; // 300 ms of audio kept before speech onset
const HISTORY_MS = 30000; // voiced frames remembered for collectSpeechSince()

export class MicCapture {
  /**
   * @param {object} opts
   * @param {(seg:{samples:Float32Array, durationMs:number, peakDb:number, startedAt:number})=>void} opts.onSegment
   * @param {(level:number)=>void} [opts.onLevel] 0..1 meter value
   * @param {(speaking:boolean)=>void} [opts.onSpeechChange]
   * @param {()=>{pauseMs:number, sensitivity:number}} opts.getSettings
   */
  constructor(opts) {
    this.opts = opts;
    this.running = false;
    this.muted = false;
    this.noiseFloor = -60;
    this._resetSegment();
    this.carry = new Float32Array(0);
    this.pending = new Float32Array(0);
    this.preroll = [];
    this.history = []; // {t, frame} for voiced frames
    this.recorder = null; // raw recording for voice enrollment
    this.segSeq = 0; // increments for every new sentence
  }

  /** Start keeping every sample (used for push-to-talk recordings). */
  beginCapture() { this.capture = []; }

  /** Stop keeping samples and return everything captured since beginCapture(). */
  endCapture() {
    const out = concat(this.capture || []);
    this.capture = null;
    return out;
  }

  /** End the current sentence now (e.g. the Talk button was released). */
  flush() {
    if (this.inSpeech) this._emit();
  }

  /** Audio of the sentence currently being spoken (for live previews), or null. */
  currentSegment() {
    return this.inSpeech ? concat(this.segFrames) : null;
  }

  async start() {
    if (this.running) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.ratio = this.ctx.sampleRate / SAMPLE_RATE;
    this.source = this.ctx.createMediaStreamSource(this.stream);
    // ScriptProcessor is deprecated but universally supported and needs no extra module file.
    this.proc = this.ctx.createScriptProcessor(4096, 1, 1);
    this.proc.onaudioprocess = (e) => this._onAudio(e.inputBuffer.getChannelData(0));
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.proc);
    this.proc.connect(this.sink);
    this.sink.connect(this.ctx.destination);
    this.running = true;
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    try { this.proc.disconnect(); this.source.disconnect(); this.sink.disconnect(); } catch {}
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this._resetSegment();
    this.opts.onLevel?.(0);
  }

  /** Ignore incoming audio (e.g. while the app itself is talking). */
  setMuted(muted) {
    this.muted = muted;
    if (muted) {
      if (this.inSpeech) this.opts.onSpeechChange?.(false);
      this._resetSegment();
      this.preroll = [];
    }
  }

  /** Record raw audio for `ms` milliseconds (used for "teach my voice"). */
  record(ms) {
    return new Promise((resolve) => {
      this.recorder = { chunks: [], remaining: Math.round((ms / 1000) * SAMPLE_RATE), resolve };
    });
  }

  /** Voiced audio captured since timestamp `t` (performance.now()). */
  collectSpeechSince(t) {
    const frames = this.history.filter((h) => h.t >= t).map((h) => h.frame);
    return concat(frames);
  }

  _resetSegment() {
    this.inSpeech = false;
    this.segFrames = [];
    this.speechRun = 0;
    this.silenceRun = 0;
    this.voicedFrames = 0;
    this.peakDb = -100;
    this.segStart = 0;
  }

  _onAudio(input) {
    const down = this._downsample(input);
    // Level meter
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / input.length);
    this.opts.onLevel?.(this.muted ? 0 : Math.min(1, rms * 6));

    if (this.capture && !this.muted) this.capture.push(down);

    if (this.recorder) {
      const r = this.recorder;
      const take = down.subarray(0, Math.min(down.length, r.remaining));
      r.chunks.push(take.slice());
      r.remaining -= take.length;
      if (r.remaining <= 0) {
        this.recorder = null;
        r.resolve(concat(r.chunks));
      }
      return;
    }

    // Split into 30 ms frames
    let buf = this.pending.length ? concat([this.pending, down]) : down;
    let off = 0;
    while (off + FRAME <= buf.length) {
      this._onFrame(buf.slice(off, off + FRAME));
      off += FRAME;
    }
    this.pending = buf.slice(off);
  }

  _downsample(input) {
    const data = this.carry.length ? concat([this.carry, input]) : input;
    const ratio = this.ratio;
    if (ratio === 1) { this.carry = new Float32Array(0); return data.slice(); }
    const n = Math.floor(data.length / ratio);
    const out = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const s = Math.round(k * ratio);
      const e = Math.min(data.length, Math.round((k + 1) * ratio));
      let acc = 0;
      for (let i = s; i < e; i++) acc += data[i];
      out[k] = acc / Math.max(1, e - s);
    }
    this.carry = data.slice(Math.round(n * ratio));
    return out;
  }

  _onFrame(frame) {
    if (this.muted) return;
    const { pauseMs, sensitivity } = this.opts.getSettings();
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const db = 10 * Math.log10(sum / frame.length + 1e-10);

    // Adaptive noise floor: falls fast, rises slowly, frozen during speech.
    if (!this.inSpeech) {
      this.noiseFloor = db < this.noiseFloor
        ? 0.7 * this.noiseFloor + 0.3 * db
        : this.noiseFloor + 0.01 * (db - this.noiseFloor);
    }
    // sensitivity 0..100 → margin above the noise floor of 18..4 dB
    const margin = 18 - (sensitivity / 100) * 14;
    const threshold = Math.max(this.noiseFloor + margin, -62);
    const isSpeech = db > threshold;

    const now = performance.now();
    if (isSpeech) {
      this.history.push({ t: now, frame });
      while (this.history.length && now - this.history[0].t > HISTORY_MS) this.history.shift();
    }

    if (!this.inSpeech) {
      this.preroll.push(frame);
      if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
      this.speechRun = isSpeech ? this.speechRun + 1 : 0;
      if (this.speechRun >= 4) {
        this.inSpeech = true;
        this.segSeq++;
        this.segFrames = this.preroll.slice();
        this.preroll = [];
        this.voicedFrames = this.speechRun;
        this.silenceRun = 0;
        this.peakDb = db;
        this.segStart = now - this.segFrames.length * FRAME_MS;
        this.opts.onSpeechChange?.(true);
      }
      return;
    }

    this.segFrames.push(frame);
    this.peakDb = Math.max(this.peakDb, db);
    if (isSpeech) { this.voicedFrames++; this.silenceRun = 0; } else this.silenceRun++;

    const durMs = this.segFrames.length * FRAME_MS;
    if (this.silenceRun * FRAME_MS >= pauseMs || durMs >= 15000) {
      this._emit();
    }
  }

  _emit() {
    const voicedMs = this.voicedFrames * FRAME_MS;
    // Trim most of the trailing silence, keep ~200 ms.
    const keep = Math.max(0, this.segFrames.length - Math.max(0, this.silenceRun - 7));
    const samples = concat(this.segFrames.slice(0, keep));
    const seg = { seq: this.segSeq, samples, durationMs: samples.length / SAMPLE_RATE * 1000, peakDb: this.peakDb, startedAt: this.segStart };
    this.opts.onSpeechChange?.(false);
    this._resetSegment();
    if (voicedMs >= 300) this.opts.onSegment(seg);
  }
}

export function concat(arrays) {
  let len = 0;
  for (const a of arrays) len += a.length;
  const out = new Float32Array(len);
  let o = 0;
  for (const a of arrays) { out.set(a, o); o += a.length; }
  return out;
}

// ---------------------------------------------------------------------------
// Voiceprint: median pitch + mean MFCC vector
// ---------------------------------------------------------------------------
const N_FFT = 512;
const HOP = 256;
const N_MEL = 26;
const N_MFCC = 13; // we keep c1..c12
let melBank = null;
let hann = null;

function buildMel() {
  const hz2mel = (h) => 2595 * Math.log10(1 + h / 700);
  const mel2hz = (m) => 700 * (10 ** (m / 2595) - 1);
  const lo = hz2mel(80), hi = hz2mel(7600);
  const pts = Array.from({ length: N_MEL + 2 }, (_, i) => mel2hz(lo + ((hi - lo) * i) / (N_MEL + 1)));
  const bins = pts.map((h) => Math.floor(((N_FFT + 1) * h) / SAMPLE_RATE));
  melBank = [];
  for (let m = 1; m <= N_MEL; m++) {
    const f = new Float32Array(N_FFT / 2 + 1);
    for (let k = bins[m - 1]; k < bins[m]; k++) f[k] = (k - bins[m - 1]) / Math.max(1, bins[m] - bins[m - 1]);
    for (let k = bins[m]; k < bins[m + 1]; k++) f[k] = (bins[m + 1] - k) / Math.max(1, bins[m + 1] - bins[m]);
    melBank.push(f);
  }
  hann = Float32Array.from({ length: N_FFT }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N_FFT - 1)));
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

function framePitch(frame) {
  // Normalised autocorrelation, 70–400 Hz.
  const minLag = Math.floor(SAMPLE_RATE / 400), maxLag = Math.floor(SAMPLE_RATE / 70);
  let energy = 0;
  for (let i = 0; i < frame.length; i++) energy += frame[i] * frame[i];
  if (energy < 1e-6) return 0;
  let best = 0, bestLag = 0;
  const corr = new Float32Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag + 1; lag++) {
    let c = 0, e1 = 0, e2 = 0;
    for (let i = 0; i + lag < frame.length; i++) {
      c += frame[i] * frame[i + lag];
      e1 += frame[i] * frame[i];
      e2 += frame[i + lag] * frame[i + lag];
    }
    corr[lag] = c / Math.sqrt(e1 * e2 + 1e-12);
  }
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (corr[lag] > best && corr[lag] >= corr[lag - 1] && corr[lag] >= corr[lag + 1]) { best = corr[lag]; bestLag = lag; }
  }
  if (best < 0.5 || !bestLag) return 0;
  // Prefer the first strong peak to avoid octave errors.
  for (let lag = minLag; lag < bestLag; lag++) {
    if (corr[lag] > 0.9 * best && corr[lag] >= corr[lag - 1] && corr[lag] >= corr[lag + 1]) { bestLag = lag; break; }
  }
  const a = corr[bestLag - 1], b = corr[bestLag], c = corr[bestLag + 1];
  const shift = (a - c) / (2 * (a - 2 * b + c) || 1);
  return SAMPLE_RATE / (bestLag + (Number.isFinite(shift) ? shift : 0));
}

/**
 * @param {Float32Array} samples 16 kHz mono
 * @returns {{f0:number, vec:number[], frames:number} | null}
 */
export function voiceprint(samples) {
  if (!melBank) buildMel();
  const frames = [];
  let maxE = -Infinity;
  for (let off = 0; off + N_FFT <= samples.length; off += HOP) {
    const f = samples.subarray(off, off + N_FFT);
    let e = 0;
    for (let i = 0; i < f.length; i++) e += f[i] * f[i];
    const db = 10 * Math.log10(e / f.length + 1e-10);
    frames.push({ f, db });
    if (db > maxE) maxE = db;
  }
  const loud = frames.filter((fr) => fr.db > maxE - 25);
  if (loud.length < 5) return null;

  const pitches = [];
  const sumC = new Float64Array(N_MFCC);
  for (const { f } of loud) {
    const p = framePitch(f);
    if (p) pitches.push(p);
    const re = new Float32Array(N_FFT), im = new Float32Array(N_FFT);
    for (let i = 0; i < N_FFT; i++) re[i] = f[i] * hann[i];
    fft(re, im);
    const logMel = new Float64Array(N_MEL);
    for (let m = 0; m < N_MEL; m++) {
      let acc = 0;
      const fb = melBank[m];
      for (let k = 0; k <= N_FFT / 2; k++) if (fb[k]) acc += fb[k] * (re[k] * re[k] + im[k] * im[k]);
      logMel[m] = Math.log(acc + 1e-10);
    }
    for (let c = 0; c < N_MFCC; c++) {
      let acc = 0;
      for (let m = 0; m < N_MEL; m++) acc += logMel[m] * Math.cos((Math.PI * c * (m + 0.5)) / N_MEL);
      sumC[c] += acc;
    }
  }
  pitches.sort((a, b) => a - b);
  const f0 = pitches.length >= 3 ? pitches[Math.floor(pitches.length / 2)] : 0;
  const vec = Array.from(sumC.slice(1), (v) => v / loud.length);
  return { f0, vec, frames: loud.length };
}
