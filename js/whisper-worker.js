// Web Worker: runs OpenAI Whisper fully in the browser via transformers.js.
//
// Language identification is limited to the languages of the people in the
// conversation; this is how HearClear works out who is speaking. It happens
// inside a single generate() call (one encoder pass): a logits processor
// restricts the first decoded token to the candidate language tokens, then
// forces <|transcribe|><|notimestamps|>, and the text follows.
import {
  AutoTokenizer,
  AutoProcessor,
  WhisperForConditionalGeneration,
  LogitsProcessor,
  LogitsProcessorList,
  TextStreamer,
  env,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';

env.allowLocalModels = false;

let model = null;
let processor = null;
let tokenizer = null;
let loadedId = null;
let device = 'wasm';

async function pickDevice(pref) {
  if (pref === 'wasm') return 'wasm';
  try {
    if (self.navigator?.gpu && (await self.navigator.gpu.requestAdapter())) return 'webgpu';
  } catch {}
  return 'wasm';
}

async function load(modelId, devicePref) {
  if (model && loadedId === modelId) {
    self.postMessage({ type: 'ready', device, model: modelId });
    return;
  }
  device = await pickDevice(devicePref);
  const progress_callback = (p) => self.postMessage({ type: 'progress', data: p });
  const dtype = device === 'webgpu'
    ? { encoder_model: 'fp32', decoder_model_merged: 'q4' }
    : { encoder_model: 'q8', decoder_model_merged: 'q8' };

  tokenizer = await AutoTokenizer.from_pretrained(modelId, { progress_callback });
  processor = await AutoProcessor.from_pretrained(modelId, { progress_callback });
  model = await WhisperForConditionalGeneration.from_pretrained(modelId, { dtype, device, progress_callback });
  loadedId = modelId;

  // Warm up (compiles WebGPU shaders) so the first real sentence is fast.
  try {
    const inputs = await processor(new Float32Array(16000));
    await model.generate({ ...inputs, language: 'en', max_new_tokens: 1 });
  } catch {}
  self.postMessage({ type: 'ready', device, model: modelId });
}

function langTokenId(code) {
  const map = model.generation_config.lang_to_id || {};
  return map[`<|${code}|>`];
}

/** Restricts the language token to the candidates, then forces the task prompt. */
class LanguagePromptProcessor extends LogitsProcessor {
  constructor(langIds, forcedIds, beginSuppress) {
    super();
    this.langIds = langIds;
    this.forced = forcedIds; // [transcribe, notimestamps]
    this.beginSuppress = beginSuppress || [];
    this.probs = null;
  }

  _call(input_ids, logits) {
    for (let i = 0; i < input_ids.length; i++) {
      const len = input_ids[i].length;
      const data = logits[i].data;
      if (len === 1) {
        const scores = this.langIds.map((id) => Number(data[id]));
        const max = Math.max(...scores);
        const exps = scores.map((s) => Math.exp(s - max));
        const total = exps.reduce((a, b) => a + b, 0);
        this.probs = exps.map((e) => e / total);
        keepOnly(data, this.langIds);
      } else if (len === 2 || len === 3) {
        keepOnly(data, [this.forced[len - 2]]);
      } else if (len === 4) {
        for (const id of this.beginSuppress) data[id] = -Infinity;
      }
    }
    return logits;
  }
}

function keepOnly(data, ids) {
  const keep = ids.map((id) => data[id]);
  data.fill(-Infinity);
  ids.forEach((id, k) => { data[id] = Number.isFinite(keep[k]) ? keep[k] : 0; });
}

/**
 * @param {Float32Array} audio 16 kHz mono
 * @param {string[]} languages Whisper language codes to choose from
 * @param {{maxTokens:number, onText?:(s:string)=>void}} opts
 */
async function run(audio, languages, { maxTokens, onText }) {
  const t0 = performance.now();
  const inputs = await processor(audio);
  const gc = model.generation_config;
  // Cantonese only exists in large-v3; map to Chinese for smaller models.
  const cands = [...new Set(languages.map((l) => (langTokenId(l) === undefined && l === 'yue' ? 'zh' : l)))]
    .filter((l) => langTokenId(l) !== undefined);
  if (!cands.length) cands.push('en');

  const streamer = onText
    ? new TextStreamer(tokenizer, { skip_prompt: true, skip_special_tokens: true, callback_function: onText })
    : undefined;

  let ids;
  let language = cands[0];
  let probs = { [language]: 1 };
  if (cands.length === 1) {
    ids = await model.generate({ ...inputs, language, task: 'transcribe', max_new_tokens: maxTokens, no_repeat_ngram_size: 4, streamer });
  } else {
    const langIds = cands.map(langTokenId);
    const proc = new LanguagePromptProcessor(langIds, [gc.task_to_id.transcribe, gc.no_timestamps_token_id], gc.begin_suppress_tokens);
    const logits_processor = new LogitsProcessorList();
    logits_processor.push(proc);
    ids = await model.generate({
      ...inputs,
      decoder_input_ids: [gc.decoder_start_token_id],
      logits_processor,
      max_new_tokens: maxTokens + 3,
      no_repeat_ngram_size: 4,
      streamer,
    });
    const chosen = Number(ids.tolist()[0][1]);
    language = cands[langIds.indexOf(chosen)] ?? cands[0];
    if (proc.probs) probs = Object.fromEntries(cands.map((c, k) => [c, proc.probs[k]]));
  }
  const text = tokenizer.batch_decode(ids, { skip_special_tokens: true })[0].trim();
  return { text, language, probs, ms: Math.round(performance.now() - t0) };
}

async function handle(msg) {
  try {
    if (msg.type === 'load') {
      await load(msg.model, msg.device);
    } else if (msg.type === 'transcribe') {
      // Final pass: stream words back as they are decoded.
      const res = await run(msg.audio, msg.languages, {
        maxTokens: 220,
        onText: (t) => self.postMessage({ type: 'token', id: msg.id, text: t }),
      });
      self.postMessage({ type: 'result', id: msg.id, ...res });
    } else if (msg.type === 'partial') {
      // Live preview while someone is still talking.
      const res = await run(msg.audio, msg.languages, { maxTokens: 96 });
      self.postMessage({ type: 'result', id: msg.id, ...res });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: String(err?.message || err) });
  }
}

// Run one job at a time: ONNX sessions must not be used concurrently.
let chain = Promise.resolve();
self.onmessage = (e) => { chain = chain.then(() => handle(e.data)); };
