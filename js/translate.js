// Translation with graceful fallbacks. No API keys needed.
//   builtin  – Chrome's on-device Translator API (private, when available)
//   google   – Google Translate's free web endpoint
//   mymemory – MyMemory free translation API
import { getLang } from './languages.js';

const cache = new Map();
const builtinTranslators = new Map();

async function viaBuiltin(text, from, to) {
  if (!('Translator' in self)) throw new Error('Built-in translator not available');
  const key = `${from}>${to}`;
  let t = builtinTranslators.get(key);
  if (!t) {
    const availability = await self.Translator.availability({ sourceLanguage: from, targetLanguage: to });
    if (availability === 'unavailable') throw new Error('Language pair not supported by built-in translator');
    t = await self.Translator.create({ sourceLanguage: from, targetLanguage: to });
    builtinTranslators.set(key, t);
  }
  return t.translate(text);
}

async function viaGoogle(text, from, to) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=${encodeURIComponent(from)}&tl=${encodeURIComponent(to)}&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google translate HTTP ${res.status}`);
  const data = await res.json();
  const out = (data?.[0] || []).map((seg) => seg?.[0] || '').join('');
  if (!out) throw new Error('Empty translation');
  return out;
}

async function viaMyMemory(text, from, to) {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(from)}|${encodeURIComponent(to)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MyMemory HTTP ${res.status}`);
  const data = await res.json();
  const out = data?.responseData?.translatedText;
  if (!out || data.responseStatus >= 400) throw new Error(data?.responseDetails || 'MyMemory failed');
  return out;
}

const PROVIDERS = { builtin: viaBuiltin, google: viaGoogle, mymemory: viaMyMemory };

/**
 * @param {string} text
 * @param {string} fromCode BCP-47 code from languages.js
 * @param {string} toCode   BCP-47 code from languages.js
 * @param {'auto'|'builtin'|'google'|'mymemory'} provider
 */
export async function translate(text, fromCode, toCode, provider = 'auto') {
  const from = getLang(fromCode).tr;
  const to = getLang(toCode).tr;
  if (from === to) return { text, provider: 'none' };
  const key = `${provider}|${from}|${to}|${text}`;
  if (cache.has(key)) return cache.get(key);

  const order = provider === 'auto' ? ['google', 'mymemory', 'builtin'] : [provider];
  let lastErr;
  for (const name of order) {
    try {
      // The built-in API uses ISO codes without region for most languages.
      const f = name === 'builtin' ? from.split('-')[0].replace('iw', 'he') : from;
      const t = name === 'builtin' ? (to === 'zh-TW' ? 'zh-Hant' : to.split('-')[0].replace('iw', 'he')) : to;
      const out = await PROVIDERS[name](text, f, t);
      const result = { text: decodeEntities(out), provider: name };
      cache.set(key, result);
      return result;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Translation failed');
}

function decodeEntities(s) {
  if (!/[&][#a-z0-9]+;/i.test(s)) return s;
  const el = document.createElement('textarea');
  el.innerHTML = s;
  return el.value;
}
