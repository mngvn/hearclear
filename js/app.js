import { LANGUAGES, getLang, DEFAULT_LANG_ROTATION } from './languages.js';
import { MicCapture, voiceprint } from './audio.js';
import { updateProfile, genderFromPitch } from './speaker.js';
import { WhisperEngine, BrowserSpeechEngine, browserSpeechSupported } from './engines.js';
import { translate } from './translate.js';
import { speak, cancelSpeech, unlockTTS, ttsSupported } from './tts.js';
import { createWizard } from './wizard.js';

// HearClear: push-to-talk translation.
// Tap a person's Talk button → their words and the translation appear live →
// tap again to save → press 🔊 Play on the translation so the other person hears it.

const $ = (s, el = document) => el.querySelector(s);
const STORE_KEY = 'hearclear:v1';
const TOUR_KEY = 'hearclear:toured2';
const LOAD_FLAG = 'hearclear:model-loading'; // set while the model loads; left behind if the tab crashes
const SETTINGS_VERSION = 2;
const MAX_SAVED_MESSAGES = 300;
const TINY_MODEL = 'onnx-community/whisper-tiny';
const COLORS = ['#4f46e5', '#0891b2', '#d97706', '#db2777', '#059669', '#7c3aed', '#dc2626', '#2563eb'];
const MAX_PEOPLE = 8;
const IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// ---------------------------------------------------------------------------
// State & persistence
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  v: SETTINGS_VERSION,
  engine: 'whisper',
  model: 'onnx-community/whisper-base',
  device: 'auto', // auto | webgpu | wasm
  translator: 'auto',
  autoSpeak: false,
  rate: 1,
};

const state = {
  people: [],
  messages: [],
  settings: { ...DEFAULT_SETTINGS },
};

let uid = Date.now();
const newId = () => (uid++).toString(36);

function storageGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function storageSet(key, val) { try { localStorage.setItem(key, val); } catch {} }
function storageRemove(key) { try { localStorage.removeItem(key); } catch {} }

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 150);
}
function saveNow() {
  clearTimeout(saveTimer);
  const messages = state.messages.slice(-MAX_SAVED_MESSAGES).map((m) => ({
    ...m,
    translations: Object.fromEntries(Object.entries(m.translations).filter(([, t]) => t.status === 'done')),
  }));
  storageSet(STORE_KEY, JSON.stringify({ people: state.people, settings: state.settings, messages }));
}
window.addEventListener('pagehide', saveNow);

function defaultLangFor(index, taken) {
  if (index === 0) {
    const nav = (navigator.language || 'en-US').toLowerCase();
    const exact = LANGUAGES.find((l) => l.code.toLowerCase() === nav);
    const base = LANGUAGES.find((l) => l.code.split('-')[0] === nav.split('-')[0]);
    return (exact || base || LANGUAGES[0]).code;
  }
  const takenBases = taken.map((c) => getLang(c).tr);
  return DEFAULT_LANG_ROTATION.find((c) => !takenBases.includes(getLang(c).tr)) || 'en-US';
}

function makePerson(index) {
  const lang = defaultLangFor(index, state.people.map((p) => p.lang));
  const usedColors = state.people.map((p) => p.color);
  return {
    id: newId(),
    name: `Person ${index + 1}`,
    lang,
    voice: 'auto',
    color: COLORS.find((c) => !usedColors.includes(c)) || COLORS[index % COLORS.length],
    profile: null,
  };
}

function load() {
  try {
    const raw = JSON.parse(storageGet(STORE_KEY) || 'null');
    if (raw?.settings) {
      const old = raw.settings;
      state.settings = { ...DEFAULT_SETTINGS };
      for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in old && k !== 'v') state.settings[k] = old[k];
      // v1 read translations aloud automatically; now the Play button is the default.
      if ((old.v || 1) < 2) state.settings.autoSpeak = false;
      state.settings.v = SETTINGS_VERSION;
    }
    if (Array.isArray(raw?.people) && raw.people.length >= 2) state.people = raw.people;
    if (Array.isArray(raw?.messages)) {
      const ids = new Set(state.people.map((p) => p.id));
      state.messages = raw.messages.filter((m) => ids.has(m.personId) && m.text);
    }
  } catch {}
  if (state.people.length < 2) {
    state.people = [];
    state.people.push(makePerson(0));
    state.people.push(makePerson(1));
  }
  if (state.settings.engine === 'browser' && !browserSpeechSupported()) state.settings.engine = 'whisper';
}

const person = (id) => state.people.find((p) => p.id === id);
const whisperCode = (p) => {
  const w = getLang(p.lang).whisper;
  return w === 'yue' ? 'zh' : w;
};
const effectiveGender = (p) => (p.voice !== 'auto' ? p.voice : genderFromPitch(p.profile?.f0));

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
const els = {
  people: $('#people'),
  addPerson: $('#add-person'),
  status: $('#status'),
  progress: $('#progress'),
  progressFill: $('#progress-fill'),
  banner: $('#banner'),
  modeChip: $('#mode-chip'),
  skip: $('#skip-btn'),
  tpl: $('#person-tpl'),
};

const IDLE_STATUS = 'Tap 🎙️ Talk on your card, speak, then tap it again to save.';
function setStatus(text, { dots = false } = {}) {
  els.status.textContent = text;
  els.status.classList.toggle('dots', dots);
}

let bannerTimer;
function showBanner(html, { error = false, timeout = 0 } = {}) {
  els.banner.innerHTML = html;
  els.banner.classList.toggle('error', error);
  els.banner.hidden = false;
  clearTimeout(bannerTimer);
  if (timeout) bannerTimer = setTimeout(() => (els.banner.hidden = true), timeout);
}
function hideBanner() { els.banner.hidden = true; }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function updateModeChip() {
  const s = state.settings;
  const size = s.model.split('-').pop();
  els.modeChip.textContent = s.engine === 'whisper'
    ? `On-device AI · Whisper ${size}${whisper?.ready ? (whisper.device === 'webgpu' ? ' · GPU' : ' · CPU') : ''}`
    : 'Browser speech';
}

function initial(name, idx) {
  const m = /^person\s*(\d+)$/i.exec(name.trim());
  return m ? m[1] : (name.trim()[0] || String(idx + 1)).toUpperCase();
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------
const langOptions = LANGUAGES.map((l) => `<option value="${l.code}">${escapeHtml(l.name)}${l.native !== l.name.split(' (')[0] ? ` · ${escapeHtml(l.native)}` : ''}</option>`).join('');

function card(id) { return els.people.querySelector(`.person[data-id="${id}"]`); }

function renderPeople() {
  els.people.innerHTML = '';
  state.people.forEach((p, idx) => {
    const node = els.tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = p.id;
    node.style.setProperty('--c', p.color);
    $('.avatar', node).textContent = initial(p.name, idx);
    const name = $('.name', node);
    name.value = p.name;
    name.addEventListener('input', () => {
      p.name = name.value || `Person ${idx + 1}`;
      $('.avatar', node).textContent = initial(p.name, idx);
      save();
    });
    const lang = $('.lang', node);
    lang.innerHTML = langOptions;
    lang.value = p.lang;
    lang.addEventListener('change', () => {
      if (talk?.personId === p.id) cancelTalk();
      p.lang = lang.value;
      save();
      state.people.forEach((q) => renderPersonMessages(q.id));
    });
    const voice = $('.voice', node);
    voice.value = p.voice;
    voice.addEventListener('change', () => { p.voice = voice.value; save(); updateVoiceInfo(p); });
    const remove = $('.remove', node);
    remove.hidden = state.people.length <= 2;
    remove.addEventListener('click', () => removePerson(p.id));
    $('.talk-btn', node).addEventListener('click', () => onTalkClick(p.id));
    els.people.appendChild(node);
    updateVoiceInfo(p);
    renderPersonMessages(p.id);
    updateTalkButton(p.id);
  });
  els.addPerson.hidden = state.people.length >= MAX_PEOPLE;
}

function updateVoiceInfo(p) {
  const c = card(p.id);
  if (!c) return;
  const info = $('.voice-info', c);
  const g = genderFromPitch(p.profile?.f0);
  info.textContent = p.voice === 'auto' && g ? (g === 'female' ? '♀ female AI voice' : '♂ male AI voice') : '';
  info.title = p.profile?.f0 ? `Your voice: about ${Math.round(p.profile.f0)} Hz` : '';
}

function addPerson() {
  if (state.people.length >= MAX_PEOPLE) return;
  state.people.push(makePerson(state.people.length));
  save();
  renderPeople();
  card(state.people.at(-1).id)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function removePerson(id) {
  if (state.people.length <= 2) return;
  const p = person(id);
  const count = state.messages.filter((m) => m.personId === id).length;
  if (count && !confirm(`Remove ${p.name} and their ${count} message${count > 1 ? 's' : ''}?`)) return;
  if (talk?.personId === id) cancelTalk();
  state.people = state.people.filter((x) => x.id !== id);
  state.messages = state.messages.filter((m) => m.personId !== id);
  save();
  renderPeople();
}

// ---------------------------------------------------------------------------
// Messages: each person has an Original box and a Translation box
// ---------------------------------------------------------------------------
function targetLangsFor(personId, srcLang) {
  const seen = new Set([getLang(srcLang).tr]);
  const out = [];
  for (const p of state.people) {
    if (p.id === personId) continue;
    const tr = getLang(p.lang).tr;
    if (seen.has(tr)) continue;
    seen.add(tr);
    out.push(p.lang);
  }
  return out;
}
const targetLangs = (msg) => targetLangsFor(msg.personId, msg.lang);

function boxes(personId) {
  const c = card(personId);
  if (!c) return null;
  const get = (cls) => ({ list: $(`.${cls} .box-list`, c), live: $(`.${cls} .live`, c), lang: $(`.${cls} .box-lang`, c) });
  return { orig: get('orig-box'), tr: get('tr-box') };
}

function updateBoxHeaders(personId) {
  const b = boxes(personId);
  const p = person(personId);
  if (!b || !p) return;
  b.orig.lang.textContent = getLang(p.lang).name;
  const targets = targetLangsFor(p.id, p.lang).map((c) => getLang(c).name);
  b.tr.lang.textContent = targets.length ? targets.join(' · ') : 'same language as everyone';
}

const nearBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 80;
function scrollDown(...list) { for (const el of list) el.scrollTop = el.scrollHeight; }

function renderPersonMessages(personId) {
  const b = boxes(personId);
  if (!b) return;
  updateBoxHeaders(personId);
  const p = person(personId);
  const msgs = state.messages.filter((m) => m.personId === personId);
  b.orig.list.querySelectorAll('.msg, .empty').forEach((n) => n.remove());
  b.tr.list.querySelectorAll('.msg, .empty').forEach((n) => n.remove());
  if (!msgs.length && !(live?.personId === personId)) {
    b.orig.live.insertAdjacentHTML('beforebegin', `<div class="empty">Tap <strong>🎙️ Talk</strong> and speak ${escapeHtml(getLang(p.lang).name)}. Your words appear here as you say them.</div>`);
    b.tr.live.insertAdjacentHTML('beforebegin', '<div class="empty">The translation appears here, with a 🔊 Play button so the other person can hear it.</div>');
    return;
  }
  for (const m of msgs) {
    const { orig, tr } = messageNodes(m);
    b.orig.live.before(orig);
    b.tr.live.before(tr);
  }
  scrollDown(b.orig.list, b.tr.list);
}

function messageNodes(m) {
  const src = getLang(m.lang);
  const time = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const orig = document.createElement('div');
  orig.className = 'msg';
  orig.dataset.id = m.id;
  orig.innerHTML = `<button class="icon-btn menu-btn" aria-label="Message options" title="Options">⋯</button>
    <div class="text" dir="auto" lang="${src.code}">${escapeHtml(m.text)}</div>
    <div class="meta">${time}</div>`;
  $('.menu-btn', orig).addEventListener('click', (e) => { e.stopPropagation(); openMessageMenu(m, orig); });

  const tr = document.createElement('div');
  tr.className = 'msg';
  tr.dataset.id = m.id;
  const codes = Object.keys(m.translations);
  const multi = codes.length > 1;
  if (!codes.length) tr.innerHTML = '<div class="text muted">(everyone speaks this language)</div>';
  for (const code of codes) {
    const t = m.translations[code];
    const L = getLang(code);
    const body = t.status === 'done' ? escapeHtml(t.text)
      : t.status === 'error' ? `Couldn't translate: ${escapeHtml(t.error)}`
      : t.text ? `${escapeHtml(t.text)}…` : 'Translating…';
    tr.insertAdjacentHTML('beforeend', `<div class="tr-line ${t.status}">
      ${multi ? `<div class="tl">${escapeHtml(L.name)}</div>` : ''}
      <div class="text" dir="auto" lang="${L.code}">${body}</div>
      ${t.status === 'done' && ttsSupported() ? `<button class="play-btn" data-lang="${code}" title="Play this out loud in ${escapeHtml(L.name)}"><span aria-hidden="true">🔊</span> Play${multi ? ` ${escapeHtml(L.name)}` : ''}</button>` : ''}
      ${t.status === 'error' ? '<button class="play-btn retry">Try again</button>' : ''}
    </div>`);
  }
  tr.querySelectorAll('.play-btn[data-lang]').forEach((btn) => btn.addEventListener('click', () => playTranslation(m, btn.dataset.lang, btn)));
  tr.querySelector('.retry')?.addEventListener('click', () => translateMessage(m));

  const pair = (on) => { orig.classList.toggle('paired', on); tr.classList.toggle('paired', on); };
  for (const n of [orig, tr]) { n.addEventListener('mouseenter', () => pair(true)); n.addEventListener('mouseleave', () => pair(false)); }
  return { orig, tr };
}

function rerenderMessage(m) {
  const b = boxes(m.personId);
  if (!b) return;
  const stick = nearBottom(b.orig.list) || nearBottom(b.tr.list);
  const { orig, tr } = messageNodes(m);
  const oldO = b.orig.list.querySelector(`.msg[data-id="${m.id}"]`);
  const oldT = b.tr.list.querySelector(`.msg[data-id="${m.id}"]`);
  b.orig.list.querySelector('.empty')?.remove();
  b.tr.list.querySelector('.empty')?.remove();
  oldO ? oldO.replaceWith(orig) : b.orig.live.before(orig);
  oldT ? oldT.replaceWith(tr) : b.tr.live.before(tr);
  if (stick || !oldO) scrollDown(b.orig.list, b.tr.list);
}

let openMenu = null;
function closeMenu() { openMenu?.remove(); openMenu = null; }
document.addEventListener('click', closeMenu);

function openMessageMenu(m, node) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'msg-menu';
  menu.innerHTML = `<button data-act="copy">📋 Copy text</button>
    <button data-act="retranslate">🔁 Translate again</button>
    <button data-act="delete">🗑 Delete</button>`;
  menu.addEventListener('click', (e) => {
    e.stopPropagation();
    const b = e.target.closest('button');
    if (!b) return;
    closeMenu();
    if (b.dataset.act === 'copy') navigator.clipboard?.writeText(m.text).catch(() => {});
    else if (b.dataset.act === 'retranslate') translateMessage(m);
    else if (b.dataset.act === 'delete') {
      state.messages = state.messages.filter((x) => x !== m);
      save();
      renderPersonMessages(m.personId);
    }
  });
  node.appendChild(menu);
  openMenu = menu;
}

async function addMessage(p, text, lang, seed = null) {
  const m = { id: newId(), personId: p.id, text, lang, ts: Date.now(), translations: {} };
  state.messages.push(m);
  save();
  await translateMessage(m, seed);
  if (state.settings.autoSpeak) {
    const first = Object.keys(m.translations).find((k) => m.translations[k].status === 'done');
    if (first) playTranslation(m, first);
  }
}

async function translateMessage(m, seed = null) {
  const targets = targetLangs(m);
  m.translations = {};
  // Keep showing the live translation until the final one arrives.
  targets.forEach((t) => (m.translations[t] = { status: 'pending', text: seed?.[t] }));
  rerenderMessage(m);
  await Promise.all(targets.map(async (t) => {
    try {
      const r = await translate(m.text, m.lang, t, state.settings.translator);
      m.translations[t] = { status: 'done', text: r.text, provider: r.provider };
    } catch (err) {
      m.translations[t] = { status: 'error', error: err.message || 'network error' };
    }
    rerenderMessage(m);
  }));
  save();
}

// ---------------------------------------------------------------------------
// Playing translations out loud
// ---------------------------------------------------------------------------
let speechChain = Promise.resolve();
let speechPending = 0;
let speechEpoch = 0;

function playTranslation(m, lang, btn) {
  const t = m.translations[lang];
  const p = person(m.personId);
  if (!t?.text) return;
  unlockTTS();
  queueSpeech([{ text: t.text, lang, gender: p ? effectiveGender(p) : null }], btn);
}

function queueSpeech(items, btn) {
  if (!ttsSupported()) {
    showBanner('This browser cannot play AI voices.', { error: true, timeout: 5000 });
    return;
  }
  const epoch = speechEpoch;
  speechPending++;
  els.skip.hidden = false;
  btn?.classList.add('playing');
  speechChain = speechChain
    .then(async () => {
      if (epoch !== speechEpoch) return;
      for (const it of items) {
        if (epoch !== speechEpoch) break;
        await speak(it.text, it.lang, it.gender, { rate: Number(state.settings.rate) || 1 });
      }
    })
    .catch(() => {})
    .finally(() => {
      speechPending--;
      btn?.classList.remove('playing');
      if (!speechPending) els.skip.hidden = true;
    });
}

function stopSpeech() {
  speechEpoch++;
  cancelSpeech();
  document.querySelectorAll('.play-btn.playing').forEach((b) => b.classList.remove('playing'));
}

// ---------------------------------------------------------------------------
// Live text while someone is talking
// ---------------------------------------------------------------------------
let live = null; // { key, personId, lang, text, tr: {code: text} }

function showLive(personId, text, lang, key) {
  if (live && live.personId !== personId) clearLiveDom(live.personId);
  if (!live || live.key !== key) live = { key, personId, lang, text: '', tr: {} };
  live.lang = lang;
  const changed = live.text !== text;
  live.text = text;
  const b = boxes(personId);
  if (!b) return;
  b.orig.list.querySelector('.empty')?.remove();
  b.tr.list.querySelector('.empty')?.remove();
  b.orig.live.hidden = false;
  b.orig.live.classList.toggle('placeholder', !text);
  b.orig.live.textContent = text || 'Listening… start speaking';
  if (!text) live.tr = {};
  renderLiveTr();
  scrollDown(b.orig.list, b.tr.list);
  if (text && changed) liveTranslate();
}

function renderLiveTr() {
  if (!live) return;
  const b = boxes(live.personId);
  if (!b) return;
  const entries = Object.entries(live.tr);
  b.tr.live.hidden = false;
  b.tr.live.classList.toggle('placeholder', !entries.length);
  b.tr.live.innerHTML = entries.length
    ? entries.map(([code, t]) => `${entries.length > 1 ? `<span class="tl">${escapeHtml(getLang(code).name)}</span> ` : ''}${escapeHtml(t)}`).join('<br>')
    : (live.text ? 'Translating…' : 'The translation will appear here');
  scrollDown(b.tr.list);
}

function clearLiveDom(personId) {
  const b = boxes(personId);
  if (!b) return;
  for (const x of [b.orig.live, b.tr.live]) { x.textContent = ''; x.hidden = true; }
}

function takeLive() {
  if (!live) return null;
  const done = live;
  live = null;
  clearLiveDom(done.personId);
  return done;
}

let liveTrBusy = false;
async function liveTranslate() {
  if (liveTrBusy || !live || !live.text) return;
  const job = { ...live };
  const targets = targetLangsFor(job.personId, job.lang);
  if (!targets.length) return;
  liveTrBusy = true;
  try {
    const results = await Promise.all(targets.map((t) =>
      translate(job.text, job.lang, t, state.settings.translator, { live: true }).then((r) => [t, r.text], () => null)));
    if (live && live.key === job.key) {
      for (const r of results) if (r) live.tr[r[0]] = r[1];
      renderLiveTr();
    }
  } finally {
    await new Promise((r) => setTimeout(r, 300));
    liveTrBusy = false;
    if (live && live.text && live.text !== job.text) liveTranslate();
  }
}

// ---------------------------------------------------------------------------
// Push to talk
// ---------------------------------------------------------------------------
let mic = null;
let whisper = null;
let browserRec = null;
let talk = null; // { key, personId, lang, engine, committed: [], partial, pending, chain, startedAt, finishing }
let talkSeq = 0;
let clockTimer = 0;
let partialTimer = 0;
let partialBusy = false;
let lastPartialAt = 0;
let lastInferMs = 800;

const HALLUCINATIONS = [
  /^(\[.*\]|\(.*\)|♪+|\*.*\*)$/,
  /subtit|amara\.org|subscribe|thanks? for watching|like and subscribe|字幕|ご視聴ありがとう|продолжение следует/i,
  /^[\s.,!?¿¡…-]*$/,
];
const isHallucination = (text) => HALLUCINATIONS.some((r) => r.test(text.trim()));
const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();

function updateTalkButton(personId) {
  const c = card(personId);
  if (!c) return;
  const btn = $('.talk-btn', c);
  const mine = talk?.personId === personId;
  const recording = mine && !talk.finishing;
  btn.setAttribute('aria-pressed', String(recording));
  btn.classList.toggle('busy', mine && talk.finishing);
  btn.disabled = mine && talk.finishing;
  $('.talk-label', c).textContent = mine
    ? (talk.finishing ? 'Saving…' : 'Done: tap to save')
    : 'Talk';
  $('.talk-time', c).textContent = recording ? formatTime(performance.now() - talk.startedAt) : '';
  c.classList.toggle('recording', recording);
}

function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function onTalkClick(personId) {
  if (talk?.personId === personId) {
    if (!talk.finishing) await finishTalk();
    return;
  }
  if (talk) await finishTalk();
  await startTalk(personId);
}

function createMic() {
  return new MicCapture({
    getSettings: () => ({ pauseMs: 700, sensitivity: 55 }),
    onSegment: (seg) => onSegment(seg),
  });
}

async function startTalk(personId) {
  const p = person(personId);
  if (!p) return;
  hideBanner();
  unlockTTS();
  stopSpeech();
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    showBanner('The microphone needs a secure (https) page. Open HearClear from its GitHub Pages address.', { error: true });
    return;
  }
  const engine = state.settings.engine === 'browser' && browserSpeechSupported() ? 'browser' : 'whisper';
  const t = {
    key: `t${++talkSeq}`, personId, lang: p.lang, engine,
    committed: [], partial: '', pending: 0, chain: Promise.resolve(),
    startedAt: performance.now(), finishing: false,
  };
  talk = t;
  updateTalkButton(personId);
  setStatus('Opening the microphone', { dots: true });

  // The mic is used for Whisper, and in browser mode to measure pitch (AI voice gender).
  // Phones often can't share the mic with browser speech recognition, so skip it there.
  if (engine === 'whisper' || !IS_MOBILE) {
    try {
      mic = createMic();
      await mic.start();
      mic.beginCapture();
    } catch (err) {
      mic = null;
      if (engine === 'whisper' || err?.name === 'NotAllowedError') {
        talk = null;
        updateTalkButton(personId);
        setStatus(IDLE_STATUS);
        showBanner(err?.name === 'NotAllowedError'
          ? 'Microphone access was blocked. Tap the lock icon in the address bar, allow the microphone, then try again.'
          : `Could not open the microphone: ${escapeHtml(err?.message || err)}`, { error: true });
        return;
      }
    }
  }
  if (talk !== t) return;

  showLive(personId, '', p.lang, t.key);
  t.startedAt = performance.now();
  clockTimer = setInterval(() => updateTalkButton(personId), 500);

  if (engine === 'browser') {
    browserRec = new BrowserSpeechEngine({
      onUpdate: (finals, interim) => {
        if (talk !== t || t.finishing) return;
        showLive(personId, clean(`${finals} ${interim}`), t.lang, t.key);
      },
      onError: (err) => {
        const msgs = {
          'not-allowed': 'Microphone access was blocked. Allow the microphone for this site and try again.',
          'service-not-allowed': 'This browser does not allow speech recognition here. Switch to “On-device AI” in Settings.',
          network: 'Browser speech needs an internet connection. Check your connection, or switch to “On-device AI” in Settings.',
          'language-not-supported': 'This browser cannot recognise that language. Switch to “On-device AI” in Settings.',
          'audio-capture': 'No microphone was found.',
        };
        showBanner(escapeHtml(msgs[err] || `Speech recognition error: ${err}`), { error: true, timeout: 10000 });
        if (['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'].includes(err) && talk === t) cancelTalk();
      },
    });
    browserRec.start(p.lang);
    setStatus(`Listening to ${p.name}. Tap the button again when you're done.`);
  } else {
    partialTimer = setInterval(maybePartial, 200);
    if (whisper?.isReady(state.settings.model, resolveDevice())) {
      setStatus(`Listening to ${p.name}. Tap the button again when you're done.`);
    } else {
      setStatus('Recording. The speech model is still loading, so your words will appear once it is ready', { dots: true });
    }
  }
}

function updateTalkLive(t) {
  if (talk !== t || t.finishing) return;
  showLive(t.personId, clean([...t.committed, t.partial].join(' ')), t.lang, t.key);
}

/** A pause inside a recording: transcribe that sentence properly and lock it in. */
function onSegment(seg) {
  const t = talk;
  if (!t || t.engine !== 'whisper') return;
  const p = person(t.personId);
  t.pending++;
  t.chain = t.chain.then(async () => {
    try {
      await ensureWhisper();
      const res = await whisper.transcribe(seg.samples, [whisperCode(p)]);
      const text = clean(res.text);
      if (text && !isHallucination(text)) t.committed.push(text);
      t.partial = '';
    } catch (err) {
      console.error(err);
    } finally {
      t.pending--;
      updateTalkLive(t);
    }
  });
}

/** While still speaking, preview the unfinished sentence about once a second. */
function maybePartial() {
  const t = talk;
  if (!t || t.finishing || t.engine !== 'whisper' || !mic?.inSpeech) return;
  if (!whisper?.isReady(state.settings.model, resolveDevice()) || partialBusy || t.pending > 0) return;
  if (lastInferMs > 5000) return; // device too slow for previews; text appears at each pause instead
  const now = performance.now();
  if (now - lastPartialAt < Math.max(600, lastInferMs * 1.2)) return;
  const audio = mic.currentSegment();
  if (!audio || audio.length < 16000 * 0.5) return;
  const seq = mic.segSeq;
  partialBusy = true;
  lastPartialAt = now;
  whisper.partial(audio, [whisperCode(person(t.personId))])
    .then((res) => {
      lastInferMs = res.ms;
      const text = clean(res.text);
      if (talk !== t || t.finishing || seq !== mic?.segSeq || t.pending > 0) return;
      if (text && !isHallucination(text)) { t.partial = text; updateTalkLive(t); }
    })
    .catch(() => {})
    .finally(() => { partialBusy = false; });
}

async function finishTalk() {
  const t = talk;
  if (!t || t.finishing) return;
  t.finishing = true;
  clearInterval(partialTimer);
  clearInterval(clockTimer);
  updateTalkButton(t.personId);
  setStatus('Saving', { dots: true });
  const p = person(t.personId);
  let text = '';
  let raw = null;
  try {
    if (t.engine === 'browser') {
      text = clean(await browserRec.finish());
      browserRec = null;
      raw = mic?.running ? mic.endCapture() : null;
    } else {
      mic?.flush(); // the last sentence → onSegment
      raw = mic?.endCapture();
      await t.chain;
      text = clean(t.committed.join(' '));
      // Nothing detected as speech (e.g. a quiet voice)? Transcribe the whole recording.
      if (!text && raw && raw.length > 16000 * 0.4) {
        setStatus('Transcribing', { dots: true });
        await ensureWhisper();
        const parts = [];
        for (let off = 0; off < raw.length; off += 16000 * 28) {
          const r = await whisper.transcribe(raw.slice(off, off + 16000 * 28), [whisperCode(p)]);
          if (clean(r.text) && !isHallucination(r.text)) parts.push(clean(r.text));
        }
        text = clean(parts.join(' '));
      }
    }
  } catch (err) {
    showBanner(`Couldn't transcribe that: ${escapeHtml(err?.message || err)}`, { error: true, timeout: 8000 });
  } finally {
    mic?.stop();
    mic = null;
  }

  // Learn the speaker's pitch so "Auto" picks a matching AI voice.
  const print = raw && raw.length > 16000 * 0.5 ? voiceprint(raw) : null;
  if (p && print?.f0) { updateProfile(p, print); updateVoiceInfo(p); save(); }

  const preview = takeLive();
  if (talk === t) talk = null;
  if (p) {
    updateTalkButton(p.id);
    if (text) await addMessage(p, text, p.lang, preview?.tr);
    else {
      renderPersonMessages(p.id);
      showBanner("I didn't catch anything. Tap Talk and try speaking a little louder or closer to the microphone.", { timeout: 6000 });
    }
  }
  setStatus(IDLE_STATUS);
}

function cancelTalk() {
  const t = talk;
  if (!t) return;
  talk = null;
  clearInterval(partialTimer);
  clearInterval(clockTimer);
  browserRec?.cancel();
  browserRec = null;
  mic?.stop();
  mic = null;
  takeLive();
  updateTalkButton(t.personId);
  renderPersonMessages(t.personId);
  setStatus(IDLE_STATUS);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden && talk && !talk.finishing) finishTalk();
});

// ---------------------------------------------------------------------------
// Speech model: loads automatically, with a guard against crash/reload loops
// ---------------------------------------------------------------------------
const resolveDevice = () => (state.settings.device === 'auto' ? (IS_MOBILE ? 'wasm' : 'auto') : state.settings.device);
let modelFiles = new Map();
let modelLoading = false;

function onModelProgress(p) {
  if (p.status !== 'progress' || !p.total) return;
  modelFiles.set(p.file, { loaded: p.loaded, total: p.total });
  let loaded = 0, total = 0;
  for (const f of modelFiles.values()) { loaded += f.loaded; total += f.total; }
  const pct = Math.round((loaded / total) * 100);
  els.progress.hidden = false;
  els.progressFill.style.width = `${pct}%`;
  if (!talk) setStatus(`Loading speech model… ${pct}% (${(total / 1e6).toFixed(0)} MB, saved on this device after the first time)`);
}

function ensureWhisper() {
  if (!whisper) {
    whisper = new WhisperEngine({ onProgress: onModelProgress, onReady: () => updateModeChip(), onError: (msg) => console.error(msg) });
  }
  const model = state.settings.model;
  const device = resolveDevice();
  if (whisper.isReady(model, device)) return Promise.resolve();
  if (!modelLoading) {
    modelLoading = true;
    modelFiles = new Map();
    storageSet(LOAD_FLAG, JSON.stringify({ model, device, t: Date.now() }));
    if (!talk) setStatus('Loading speech model', { dots: true });
  }
  const pr = whisper.load(model, device);
  pr.then(() => {
    if (!whisper.isReady(model, device)) return;
    modelLoading = false;
    storageRemove(LOAD_FLAG);
    els.progress.hidden = true;
    updateModeChip();
    if (!talk) setStatus(`Ready. ${IDLE_STATUS}`);
  }, () => {
    modelLoading = false;
    storageRemove(LOAD_FLAG);
    els.progress.hidden = true;
  });
  return pr;
}

function showModelError(err) {
  const canFallback = browserSpeechSupported();
  showBanner(`Couldn't load the on-device speech model (${escapeHtml(err?.message || err)}). <button class="btn small primary" id="retry-model">Try again</button>${canFallback ? ' <button class="btn small ghost" id="use-browser">Use browser speech instead</button>' : ''}`, { error: true });
  setStatus('Speech model not loaded');
  $('#retry-model')?.addEventListener('click', () => { hideBanner(); ensureWhisper().catch(showModelError); });
  $('#use-browser')?.addEventListener('click', () => {
    state.settings.engine = 'browser';
    save(); syncSettingsForm(); updateModeChip(); hideBanner();
    setStatus(IDLE_STATUS);
  });
}

/** If the tab died while the model was loading last time, step down to something lighter. */
function checkCrashGuard() {
  const raw = storageGet(LOAD_FLAG);
  if (!raw) return true;
  storageRemove(LOAD_FLAG);
  let info;
  try { info = JSON.parse(raw); } catch { return true; }
  if (!info || Date.now() - info.t > 15 * 60 * 1000) return true;
  const s = state.settings;
  let change;
  if (info.device !== 'wasm') { s.device = 'wasm'; change = 'switched to CPU mode, which uses less memory'; }
  else if (info.model !== TINY_MODEL) { s.model = TINY_MODEL; change = 'switched to the Tiny model, which uses less memory'; }
  if (change) {
    saveNow();
    showBanner(`The page reloaded while the speech model was loading. This usually means the device ran out of memory, so HearClear ${change}. You can change this in Settings.`, { timeout: 15000 });
    return true;
  }
  showBanner('This device ran out of memory loading the speech model, even the smallest one. Switch to “Browser speech” in Settings.', { error: true });
  return false;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const settingsDialog = $('#settings-dialog');
const form = $('#settings-form');

function syncSettingsForm() {
  const s = state.settings;
  form.engine.value = s.engine;
  form.model.value = s.model;
  form.device.value = s.device;
  form.translator.value = s.translator;
  form.autoSpeak.checked = s.autoSpeak;
  form.rate.value = s.rate;
  const browserRadio = form.querySelector('input[value="browser"]');
  browserRadio.disabled = !browserSpeechSupported();
  if (!browserSpeechSupported()) browserRadio.closest('.radio-card').title = 'Not supported in this browser';
  updateSettingsOutputs();
}

function updateSettingsOutputs() {
  $('#rate-out').textContent = `${Number(form.rate.value).toFixed(1)}×`;
  form.querySelectorAll('[data-for]').forEach((el) => { el.hidden = el.dataset.for !== form.engine.value; });
}

form.addEventListener('input', () => {
  const s = state.settings;
  const before = `${s.engine}|${s.model}|${s.device}`;
  s.engine = form.engine.value;
  s.model = form.model.value;
  s.device = form.device.value;
  s.translator = form.translator.value;
  s.autoSpeak = form.autoSpeak.checked;
  s.rate = Number(form.rate.value);
  updateSettingsOutputs();
  updateModeChip();
  save();
  if (before !== `${s.engine}|${s.model}|${s.device}`) {
    if (talk) cancelTalk();
    if (s.engine === 'whisper') ensureWhisper().catch(showModelError);
  }
});

$('#settings-btn').addEventListener('click', () => { syncSettingsForm(); settingsDialog.showModal(); });

// ---------------------------------------------------------------------------
// Transcript export / clear
// ---------------------------------------------------------------------------
$('#export-btn').addEventListener('click', () => {
  if (!state.messages.length) { showBanner('Nothing to save yet.', { timeout: 2500 }); return; }
  const lines = state.messages.map((m) => {
    const p = person(m.personId);
    const t = new Date(m.ts).toLocaleTimeString();
    let s = `[${t}] ${p?.name || '?'} (${getLang(m.lang).name}): ${m.text}`;
    for (const [code, tr] of Object.entries(m.translations)) if (tr.text) s += `\n    → ${getLang(code).name}: ${tr.text}`;
    return s;
  });
  const blob = new Blob([`HearClear conversation · ${new Date().toLocaleString()}\n\n${lines.join('\n\n')}\n`], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `hearclear-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('#clear-btn').addEventListener('click', () => {
  if (state.messages.length && !confirm('Clear the whole conversation?')) return;
  state.messages = [];
  save();
  stopSpeech();
  state.people.forEach((p) => renderPersonMessages(p.id));
});

els.skip.addEventListener('click', stopSpeech);
els.addPerson.addEventListener('click', addPerson);

// ---------------------------------------------------------------------------
// Guided tour
// ---------------------------------------------------------------------------
const wizard = createWizard([
  {
    title: 'Welcome to HearClear 👋',
    html: `<p>HearClear helps two people who speak <strong>different languages</strong> talk face to face.</p>
      <ol><li>Tap <strong>🎙️ Talk</strong> on your card and speak.</li>
      <li>Watch your words and the translation appear <strong>live</strong>.</li>
      <li>Tap the same button again to <strong>save</strong> it.</li>
      <li>Press <strong>🔊 Play</strong> so the other person <strong>hears</strong> it in their language.</li></ol>`,
  },
  {
    target: '.person .person-config',
    title: 'Set up each person',
    html: '<p>Each person has a card. Tap the name to rename it, and choose the language they <strong>speak</strong>. Translations go into the other people\'s languages.</p>',
  },
  {
    target: '.person .talk-btn',
    title: 'Tap to talk, tap again to save',
    html: `<p>Tap <strong>🎙️ Talk</strong> and speak. The button turns red while it's recording.</p>
      <p>When you're finished, tap it again. Your sentence is saved and translated.</p>`,
  },
  {
    target: '.person .boxes',
    title: 'Original and translation',
    html: `<p><strong>Original</strong> shows what you said, live, as you say it. <strong>Translation</strong> shows it in the other person's language.</p>
      <p>Every saved translation has a <strong>🔊 Play</strong> button. Press it so the other person hears an AI voice read it out.</p>`,
  },
  {
    target: '.person .voice',
    title: 'The AI voice',
    html: '<p>With <strong>Auto</strong>, HearClear matches the AI voice to how high or low your voice is (female or male). You can also choose it yourself.</p>',
  },
  {
    target: '#add-person',
    title: 'More people',
    html: '<p>You start with two people. Tap <strong>Add person</strong> to add up to eight.</p>',
  },
  {
    target: '#settings-btn',
    title: 'Settings',
    html: `<p><strong>On-device AI</strong> (default) runs Whisper in your browser. It loads automatically and is saved after the first download.</p>
      <p><strong>Browser speech</strong> gives the fastest live words in Chrome, Edge and Safari.</p>
      <p>You can also turn on automatic playback here.</p>`,
  },
], {
  onFinish: () => storageSet(TOUR_KEY, '1'),
});
$('#guide-btn').addEventListener('click', () => wizard.start());

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
load();
renderPeople();
syncSettingsForm();
updateModeChip();
setStatus(IDLE_STATUS);
if (!storageGet(TOUR_KEY)) setTimeout(() => wizard.start(), 400);
if (!ttsSupported()) showBanner('This browser cannot play AI voices. Translations will still be shown as text.', { timeout: 8000 });
navigator.storage?.persist?.().catch(() => {}); // keep the cached model from being evicted
// A normal refresh/close while loading is not a crash.
window.addEventListener('pagehide', () => { if (modelLoading) storageRemove(LOAD_FLAG); });
// Finish translations that were in flight when the page was closed.
state.messages.filter((m) => targetLangs(m).some((t) => m.translations[t]?.status !== 'done')).forEach((m) => translateMessage(m));
if (state.settings.engine === 'whisper' && checkCrashGuard()) ensureWhisper().catch(showModelError);
window.hearclear = { state }; // handy for debugging
