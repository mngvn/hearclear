// Speech-to-text engines.
//
//  WhisperEngine        – on-device Whisper (auto-detects language → speaker)
//  BrowserSpeechEngine  – the browser's built-in Web Speech API (fast, one language at a time)

export class WhisperEngine {
  constructor({ onProgress, onReady, onError }) {
    this.cb = { onProgress, onReady, onError };
    this.worker = null;
    this.ready = false;
    this.loading = null;
    this.pending = new Map();
    this.seq = 0;
  }

  load(modelId, devicePref = 'auto') {
    if (this.ready && this.modelId === modelId) return Promise.resolve();
    if (this.loading && this.modelId === modelId) return this.loading;
    if (this.worker && this.modelId !== modelId) { this.worker.terminate(); this.worker = null; this.ready = false; }
    this.modelId = modelId;
    this.worker = new Worker(new URL('./whisper-worker.js', import.meta.url), { type: 'module' });
    this.loading = new Promise((resolve, reject) => {
      this.worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') this.cb.onProgress?.(m.data);
        else if (m.type === 'ready') { this.ready = true; this.device = m.device; this.cb.onReady?.(m); resolve(); }
        else if (m.type === 'result') { this.pending.get(m.id)?.resolve(m); this.pending.delete(m.id); }
        else if (m.type === 'error') {
          if (m.id != null && this.pending.has(m.id)) { this.pending.get(m.id).reject(new Error(m.message)); this.pending.delete(m.id); }
          else { this.loading = null; this.cb.onError?.(m.message); reject(new Error(m.message)); }
        }
      };
      this.worker.onerror = (e) => {
        this.loading = null;
        const msg = e.message || 'Could not start the speech model worker.';
        this.cb.onError?.(msg);
        reject(new Error(msg));
      };
    });
    this.worker.postMessage({ type: 'load', model: modelId, device: devicePref });
    return this.loading;
  }

  /** @returns {Promise<{text:string, language:string, probs:object, ms:number}>} */
  transcribe(audio, languages) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'transcribe', id, audio, languages }, [audio.buffer]);
    });
  }
}

export const browserSpeechSupported = () => !!(window.SpeechRecognition || window.webkitSpeechRecognition);

export class BrowserSpeechEngine {
  constructor({ onInterim, onFinal, onError, onSpeechStart }) {
    this.cb = { onInterim, onFinal, onError, onSpeechStart };
    this.running = false;
    this.paused = false;
    this.lang = 'en-US';
    this.rec = null;
  }

  start(lang) {
    this.lang = lang;
    this.running = true;
    this.paused = false;
    this._spawn();
  }

  setLang(lang) {
    if (lang === this.lang) return;
    this.lang = lang;
    if (this.running && !this.paused) this._restart();
  }

  pause() { this.paused = true; this._kill(); }
  resume() { if (this.running && this.paused) { this.paused = false; this._spawn(); } }
  stop() { this.running = false; this._kill(); }

  _kill() {
    if (this.rec) {
      const r = this.rec;
      this.rec = null;
      r.onend = r.onresult = r.onerror = r.onspeechstart = null;
      try { r.abort(); } catch {}
    }
  }

  _restart() { this._kill(); this._spawn(); }

  _spawn() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR || this.rec) return;
    const rec = new SR();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    const lang = this.lang;
    rec.onspeechstart = () => this.cb.onSpeechStart?.();
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          const text = r[0].transcript.trim();
          if (text) this.cb.onFinal?.(text, lang);
        } else interim += r[0].transcript;
      }
      this.cb.onInterim?.(interim.trim(), lang);
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') this.running = false;
      this.cb.onError?.(e.error);
    };
    rec.onend = () => {
      if (this.rec !== rec) return;
      this.rec = null;
      // Browsers end recognition after silence; keep it alive while the conversation runs.
      if (this.running && !this.paused) setTimeout(() => this._spawn(), 150);
    };
    this.rec = rec;
    try { rec.start(); } catch (err) { this.rec = null; this.cb.onError?.(String(err.message || err)); }
  }
}
