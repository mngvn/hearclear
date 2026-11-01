// Web Worker: runs OpenAI Whisper fully in the browser via transformers.js.
// Adds language identification restricted to the languages of the people in
// the conversation, which is how HearClear works out who is speaking.
import {
  AutoTokenizer,
  AutoProcessor,
  WhisperForConditionalGeneration,
  Tensor,
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

async function detectLanguage(inputs, candidates) {
  const usable = candidates.filter((c) => langTokenId(c) !== undefined);
  if (usable.length <= 1) return { language: usable[0] || 'en', probs: { [usable[0] || 'en']: 1 } };
  const sot = model.generation_config.decoder_start_token_id;
  const decoder_input_ids = new Tensor('int64', BigInt64Array.from([BigInt(sot)]), [1, 1]);
  const out = await model({ ...inputs, decoder_input_ids });
  const logits = out.logits.data; // [1, 1, vocab]
  // Free the KV-cache tensors (they live on the GPU with WebGPU).
  for (const k in out) if (k.startsWith('present')) out[k]?.dispose?.();
  const scores = usable.map((c) => Number(logits[langTokenId(c)]));
  const max = Math.max(...scores);
  const exps = scores.map((s) => Math.exp(s - max));
  const total = exps.reduce((a, b) => a + b, 0);
  const probs = {};
  usable.forEach((c, i) => { probs[c] = exps[i] / total; });
  const language = usable[scores.indexOf(max)];
  return { language, probs };
}

async function transcribe({ id, audio, languages }) {
  const t0 = performance.now();
  const inputs = await processor(audio);
  // Cantonese only exists in large-v3; map to Chinese for smaller models.
  const cands = [...new Set(languages.map((l) => (langTokenId(l) === undefined && l === 'yue' ? 'zh' : l)))];
  const { language, probs } = await detectLanguage(inputs, cands);
  const ids = await model.generate({
    ...inputs,
    language,
    task: 'transcribe',
    max_new_tokens: 220,
    no_repeat_ngram_size: 4,
  });
  const text = tokenizer.batch_decode(ids, { skip_special_tokens: true })[0].trim();
  self.postMessage({ type: 'result', id, text, language, probs, ms: Math.round(performance.now() - t0) });
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') await load(msg.model, msg.device);
    else if (msg.type === 'transcribe') await transcribe(msg);
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: String(err?.message || err) });
  }
};
