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

  isReady(modelId, devicePref = 'auto') {
    return this.ready && this.key === `${modelId}|${devicePref}`;
  }

  load(modelId, devicePref = 'auto') {
    const key = `${modelId}|${devicePref}`;
    if (this.ready && this.key === key) return Promise.resolve();
    if (this.loading && this.key === key) return this.loading;
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    for (const p of this.pending.values()) p.reject(new Error('Speech model was reloaded'));
    this.pending.clear();
    this.ready = false;
    this.key = key;
    this.modelId = modelId;
    this.worker = new Worker(new URL('./whisper-worker.js', import.meta.url), { type: 'module' });
    this.loading = new Promise((resolve, reject) => {
      this.worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') this.cb.onProgress?.(m.data);
        else if (m.type === 'ready') { this.ready = true; this.device = m.device; this.cb.onReady?.(m); resolve(); }
        else if (m.type === 'token') this.pending.get(m.id)?.onText?.(m.text);
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

  /**
   * Full transcription of a finished sentence. `onText` receives words as they are decoded.
   * @returns {Promise<{text:string, language:string, probs:object, ms:number}>}
   */
  transcribe(audio, languages, { onText } = {}) {
    return this._send('transcribe', audio, languages, onText);
  }

  /** Quick preview of a sentence that is still being spoken. */
  partial(audio, languages) {
    return this._send('partial', audio, languages);
  }

  _send(type, audio, languages, onText) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onText });
      this.worker.postMessage({ type, id, audio, languages }, [audio.buffer]);
    });
  }
}

export const browserSpeechSupported = () => !!(window.SpeechRecognition || window.webkitSpeechRecognition);

/**
 * Push-to-talk wrapper around the Web Speech API.
 * onUpdate(finalText, interimText) fires as words are recognised.
 */
export class BrowserSpeechEngine {
  constructor({ onUpdate, onError }) {
    this.cb = { onUpdate, onError };
    this.running = false;
    this.rec = null;
    this.committed = [];
    this.sessionFinal = '';
    this.interim = '';
  }

  start(lang) {
    this.lang = lang;
    this.running = true;
    this.committed = [];
    this.sessionFinal = '';
    this.interim = '';
    this._spawn();
  }

  text() {
    const finals = [...this.committed, this.sessionFinal].filter(Boolean).join(' ').trim();
    return finals || this.interim.trim();
  }

  /** Stop listening and resolve with everything that was said. */
  finish() {
    this.running = false;
    return new Promise((resolve) => {
      let done = false;
      const end = () => { if (!done) { done = true; resolve(this.text()); } };
      if (!this.rec) return end();
      this._onDone = end;
      setTimeout(end, 2500); // safety net if the browser never fires 'end'
      try { this.rec.stop(); } catch { end(); }
    });
  }

  cancel() {
    this.running = false;
    if (this.rec) {
      const r = this.rec;
      this.rec = null;
      r.onend = r.onresult = r.onerror = null;
      try { r.abort(); } catch {}
    }
  }

  _spawn() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR || this.rec) return;
    const rec = new SR();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      let fin = '', interim = '';
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) fin += r[0].transcript + ' ';
        else interim += r[0].transcript;
      }
      this.sessionFinal = fin.replace(/\s+/g, ' ').trim();
      this.interim = interim.trim();
      const finals = [...this.committed, this.sessionFinal].filter(Boolean).join(' ');
      this.cb.onUpdate?.(finals, this.interim);
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      this.cb.onError?.(e.error);
    };
    rec.onend = () => {
      if (this.rec !== rec) return;
      this.rec = null;
      if (this.sessionFinal) this.committed.push(this.sessionFinal);
      else if (!this.running && this.interim) this.committed.push(this.interim);
      this.sessionFinal = '';
      this.interim = '';
      // Browsers stop after a silence; keep listening until the button is pressed again.
      if (this.running) setTimeout(() => this._spawn(), 100);
      else this._onDone?.();
    };
    this.rec = rec;
    try { rec.start(); } catch (err) { this.rec = null; this.cb.onError?.(String(err.message || err)); }
  }
}
