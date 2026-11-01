import { LANGUAGES, getLang, DEFAULT_LANG_ROTATION } from './languages.js';
import { MicCapture, voiceprint } from './audio.js';
import { identifySpeaker, updateProfile, genderFromPitch } from './speaker.js';
import { WhisperEngine, BrowserSpeechEngine, browserSpeechSupported } from './engines.js';
import { translate } from './translate.js';
import { speak, cancelSpeech, unlockTTS, ttsSupported } from './tts.js';
import { createWizard } from './wizard.js';

const $ = (s, el = document) => el.querySelector(s);
const STORE_KEY = 'hearclear:v1';
const TOUR_KEY = 'hearclear:toured';
const LOAD_FLAG = 'hearclear:model-loading'; // set while the model loads; left behind if the tab crashes
const MAX_SAVED_MESSAGES = 300;
const TINY_MODEL = 'onnx-community/whisper-tiny';
const IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const COLORS = ['#4f46e5', '#0891b2', '#d97706', '#db2777', '#059669', '#7c3aed', '#dc2626', '#2563eb'];
const MAX_PEOPLE = 8;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  engine: 'whisper',
  model: 'onnx-community/whisper-base',
  device: 'auto', // auto | webgpu | wasm
  autoTurn: true,
  translator: 'auto',
  autoSpeak: true,
  livePreview: true,
  rate: 1,
  headphones: false,
  pauseMs: 800,
  sensitivity: 50,
};

const state = {
  people: [],
  messages: [],
  settings: { ...DEFAULT_SETTINGS },
  running: false,
  starting: false,
  turnId: null, // browser engine: whose turn it is. whisper engine: forced speaker (or null = auto)
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
    // Don't persist half-finished translations; they are redone on load.
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
    trained: false,
  };
}

function load() {
  try {
    const raw = JSON.parse(storageGet(STORE_KEY) || 'null');
    if (raw?.settings) state.settings = { ...DEFAULT_SETTINGS, ...raw.settings };
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
  // Without browser speech recognition, only Whisper works.
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
  mic: $('#mic-btn'),
  status: $('#status'),
  meter: $('#meter-fill'),
  progress: $('#progress'),
  progressFill: $('#progress-fill'),
  banner: $('#banner'),
  modeChip: $('#mode-chip'),
  skip: $('#skip-btn'),
  tpl: $('#person-tpl'),
};

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
    ? `Auto-detect speakers · Whisper ${size}${whisper?.ready ? (whisper.device === 'webgpu' ? ' · GPU' : ' · CPU') : ''}`
    : `Browser speech · ${s.autoTurn ? 'turn-taking' : 'manual turns'}`;
}

// ---------------------------------------------------------------------------
// People rendering
// ---------------------------------------------------------------------------
const langOptions = LANGUAGES.map((l) => `<option value="${l.code}">${escapeHtml(l.name)}${l.native !== l.name.split(' (')[0] ? ` · ${escapeHtml(l.native)}` : ''}</option>`).join('');

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
      p.lang = lang.value;
      save();
      state.people.forEach((q) => renderPersonMessages(q.id));
      if (state.running && state.settings.engine === 'browser' && state.turnId === p.id) browser?.setLang(p.lang);
      updateStatusListening();
    });
    const voice = $('.voice', node);
    voice.value = p.voice;
    voice.addEventListener('change', () => { p.voice = voice.value; save(); updateVoiceInfo(p); });
    const remove = $('.remove', node);
    remove.hidden = state.people.length <= 2;
    remove.addEventListener('click', () => removePerson(p.id));
    $('.turn', node).addEventListener('click', () => onTurnClick(p.id));
    $('.enroll', node).addEventListener('click', () => openEnroll(p.id));
    els.people.appendChild(node);
    updateVoiceInfo(p);
    renderPersonMessages(p.id);
  });
  els.addPerson.hidden = state.people.length >= MAX_PEOPLE;
  updateTurnUI();
}

function initial(name, idx) {
  const m = /^person\s*(\d+)$/i.exec(name.trim());
  return m ? m[1] : (name.trim()[0] || String(idx + 1)).toUpperCase();
}

function card(id) { return els.people.querySelector(`.person[data-id="${id}"]`); }

function updateVoiceInfo(p) {
  const c = card(p.id);
  if (!c) return;
  const info = $('.voice-info', c);
  const g = genderFromPitch(p.profile?.f0);
  const parts = [];
  if (p.voice === 'auto') parts.push(g ? `${g === 'female' ? '♀ female' : '♂ male'} voice detected` : 'voice: auto-detect');
  info.textContent = parts.join(' · ');
  info.title = p.profile?.f0 ? `Average pitch ≈ ${Math.round(p.profile.f0)} Hz` : '';
  const enroll = $('.enroll', c);
  enroll.classList.toggle('trained', !!p.trained);
  enroll.textContent = p.trained ? '✓ Voice learned' : 'Teach voice';
}

function updateTurnUI() {
  for (const p of state.people) {
    const c = card(p.id);
    if (!c) continue;
    const active = state.turnId === p.id;
    c.classList.toggle('turn-active', active);
    const btn = $('.turn', c);
    if (state.settings.engine === 'whisper') {
      btn.textContent = active ? '🎙️ Speaking (tap for auto)' : '🎙️ My turn';
      btn.title = active
        ? 'Everything is assigned to this person. Tap again to go back to automatic speaker detection.'
        : 'Assign everything to this person until tapped again (overrides automatic detection).';
    } else {
      btn.textContent = active ? '🎙️ Listening…' : '🎙️ My turn';
      btn.title = 'Make HearClear listen for this person now';
    }
  }
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
  state.people = state.people.filter((x) => x.id !== id);
  state.messages = state.messages.filter((m) => m.personId !== id);
  if (state.turnId === id) state.turnId = state.settings.engine === 'browser' ? state.people[0].id : null;
  save();
  renderPeople();
  if (state.running && state.settings.engine === 'browser') browser?.setLang(person(state.turnId).lang);
}

// ---------------------------------------------------------------------------
// Messages
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

/** The two boxes of a person's card: { orig: {list, live}, tr: {list, live} } */
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
function scrollDown(...els) { for (const el of els) el.scrollTop = el.scrollHeight; }

function renderPersonMessages(personId) {
  const b = boxes(personId);
  if (!b) return;
  updateBoxHeaders(personId);
  const p = person(personId);
  const msgs = state.messages.filter((m) => m.personId === personId);
  b.orig.list.querySelectorAll('.msg, .empty').forEach((n) => n.remove());
  b.tr.list.querySelectorAll('.msg, .empty').forEach((n) => n.remove());
  if (!msgs.length) {
    b.orig.live.insertAdjacentHTML('beforebegin', `<div class="empty">What ${escapeHtml(p.name)} says in ${escapeHtml(getLang(p.lang).name)} appears here, word by word.</div>`);
    b.tr.live.insertAdjacentHTML('beforebegin', '<div class="empty">The translation appears here.</div>');
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
    <div class="meta">${time}${m.how ? ` · ${escapeHtml(m.how)}` : ''}</div>`;
  $('.menu-btn', orig).addEventListener('click', (e) => { e.stopPropagation(); openMessageMenu(m, orig); });

  const tr = document.createElement('div');
  tr.className = 'msg';
  tr.dataset.id = m.id;
  const codes = Object.keys(m.translations);
  const multi = codes.length > 1;
  if (!codes.length) tr.innerHTML = '<div class="text muted">(no translation needed)</div>';
  for (const code of codes) {
    const t = m.translations[code];
    const L = getLang(code);
    const body = t.status === 'done' ? escapeHtml(t.text)
      : t.status === 'error' ? `Couldn't translate: ${escapeHtml(t.error)}`
      : t.text ? `${escapeHtml(t.text)}…` : 'Translating…';
    tr.insertAdjacentHTML('beforeend', `<div class="tr-line ${t.status}">
      <div class="grow">${multi ? `<div class="tl">${escapeHtml(L.name)}</div>` : ''}<div class="text" dir="auto" lang="${L.code}">${body}</div></div>
      ${t.status === 'done' && ttsSupported() ? `<button class="icon-btn play" data-lang="${code}" aria-label="Play ${escapeHtml(L.name)} translation" title="Play">🔊</button>` : ''}
    </div>`);
  }
  tr.querySelectorAll('.play').forEach((btn) => btn.addEventListener('click', () => {
    const t = m.translations[btn.dataset.lang];
    const p = person(m.personId);
    if (t?.text) queueSpeech([{ text: t.text, lang: btn.dataset.lang, gender: p ? effectiveGender(p) : null }]);
  }));

  // Hovering one half highlights the other.
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

// ---------------------------------------------------------------------------
// Live (in-progress) text: words appear while someone is still talking
// ---------------------------------------------------------------------------
let live = null; // { key, personId, lang, text, tr: {code: text} }

function showLive(personId, text, lang, key) {
  if (live && live.personId !== personId) clearLiveDom(live.personId);
  if (!live || live.key !== key) live = { key, personId, lang, text: '', tr: {} };
  live.personId = personId;
  live.lang = lang;
  live.text = text;
  const b = boxes(personId);
  if (!b) return;
  b.orig.live.textContent = text;
  b.orig.live.hidden = !text;
  b.orig.list.querySelector('.empty')?.remove();
  renderLiveTr();
  card(personId)?.classList.add('speaking');
  scrollDown(b.orig.list, b.tr.list);
  if (text) liveTranslate();
}

function renderLiveTr() {
  if (!live) return;
  const b = boxes(live.personId);
  if (!b) return;
  const entries = Object.entries(live.tr);
  b.tr.live.innerHTML = entries.map(([code, t]) =>
    `${entries.length > 1 ? `<span class="tl">${escapeHtml(getLang(code).name)}</span> ` : ''}${escapeHtml(t)}`).join('<br>');
  b.tr.live.hidden = !entries.length;
  b.tr.list.querySelector('.empty')?.remove();
  scrollDown(b.tr.list);
}

function clearLiveDom(personId) {
  const b = boxes(personId);
  if (!b) return;
  for (const x of [b.orig.live, b.tr.live]) { x.textContent = ''; x.hidden = true; }
  card(personId)?.classList.remove('speaking');
}

/** Clears the live preview; returns its last translations so the final message can show them right away. */
function takeLive(key) {
  if (!live || (key !== undefined && live.key !== key)) return null;
  const done = live;
  live = null;
  clearLiveDom(done.personId);
  if (!state.messages.some((m) => m.personId === done.personId)) renderPersonMessages(done.personId);
  return done;
}

function clearAllLive() {
  live = null;
  state.people.forEach((p) => clearLiveDom(p.id));
}

// Live translation: at most one request in flight, always for the newest text.
let liveTrBusy = false;
async function liveTranslate() {
  if (liveTrBusy || !live || !state.settings.livePreview) return;
  const job = { ...live };
  const targets = targetLangsFor(job.personId, job.lang);
  if (!targets.length) return;
  liveTrBusy = true;
  try {
    const results = await Promise.all(targets.map((t) =>
      translate(job.text, job.lang, t, state.settings.translator, { live: true }).then((r) => [t, r.text], () => null)));
    if (live && live.key === job.key && live.personId === job.personId) {
      for (const r of results) if (r) live.tr[r[0]] = r[1];
      renderLiveTr();
    }
  } finally {
    await new Promise((r) => setTimeout(r, 350));
    liveTrBusy = false;
    if (live && live.text !== job.text) liveTranslate();
  }
}

let openMenu = null;
function closeMenu() { openMenu?.remove(); openMenu = null; }
document.addEventListener('click', closeMenu);

function openMessageMenu(m, node) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'msg-menu';
  const others = state.people.filter((p) => p.id !== m.personId);
  menu.innerHTML = `<div class="label">Wrong person? Move to</div>
    ${others.map((p) => `<button data-move="${p.id}">→ ${escapeHtml(p.name)} (${escapeHtml(getLang(p.lang).name)})</button>`).join('')}
    <button data-act="speak">🔊 Play translation again</button>
    <button data-act="delete">🗑 Delete</button>`;
  menu.addEventListener('click', (e) => {
    e.stopPropagation();
    const b = e.target.closest('button');
    if (!b) return;
    closeMenu();
    if (b.dataset.move) moveMessage(m, b.dataset.move);
    else if (b.dataset.act === 'speak') speakMessage(m);
    else if (b.dataset.act === 'delete') {
      state.messages = state.messages.filter((x) => x !== m);
      save();
      renderPersonMessages(m.personId);
    }
  });
  node.appendChild(menu);
  openMenu = menu;
}

function moveMessage(m, toId) {
  const from = m.personId;
  const to = person(toId);
  m.personId = toId;
  m.how = 'moved by you';
  // In browser mode the words were recognised in the original speaker's language.
  // In Whisper mode, the language was detected, so keep it. Learn the voice either way.
  if (m.print) updateProfile(to, m.print);
  renderPersonMessages(from);
  renderPersonMessages(toId);
  updateVoiceInfo(to);
  translateMessage(m);
  save();
}

async function addMessage(p, text, lang, print, how, seed = null) {
  if (print) {
    updateProfile(p, print);
    updateVoiceInfo(p);
    save();
  }
  const m = { id: newId(), personId: p.id, text, lang, ts: Date.now(), translations: {}, print, how };
  state.messages.push(m);
  save();
  flash(p.id);
  await translateMessage(m, seed?.personId === p.id ? seed.tr : null);
  if (state.settings.autoSpeak) speakMessage(m);
}

async function translateMessage(m, seed = null) {
  const targets = targetLangs(m);
  m.translations = {};
  // Show the live translation (if any) until the final one arrives.
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

function speakMessage(m) {
  const p = person(m.personId);
  const gender = p ? effectiveGender(p) : null;
  const items = Object.entries(m.translations)
    .filter(([, t]) => t.status === 'done' && t.text)
    .map(([lang, t]) => ({ text: t.text, lang, gender }));
  if (items.length) queueSpeech(items);
}

function flash(id) {
  const c = card(id);
  if (!c) return;
  c.classList.add('speaking');
  setTimeout(() => c.classList.remove('speaking'), 900);
}

// ---------------------------------------------------------------------------
// Speech output queue (the mic is muted while the AI voice talks, to avoid echo)
// ---------------------------------------------------------------------------
let speechChain = Promise.resolve();
let speechPending = 0;
let speechEpoch = 0;

function queueSpeech(items) {
  if (!ttsSupported()) return;
  const epoch = speechEpoch;
  speechPending++;
  updateSpeakingUI();
  speechChain = speechChain
    .then(async () => {
      if (epoch !== speechEpoch) return;
      setListeningPaused(true);
      for (const it of items) {
        if (epoch !== speechEpoch) break;
        await speak(it.text, it.lang, it.gender, { rate: Number(state.settings.rate) || 1 });
      }
    })
    .catch(() => {})
    .finally(() => {
      speechPending--;
      updateSpeakingUI();
      if (!speechPending) setTimeout(() => { if (!speechPending) setListeningPaused(false); }, 300);
    });
}

function skipSpeech() {
  speechEpoch++;
  cancelSpeech();
}

function updateSpeakingUI() {
  els.skip.hidden = speechPending === 0;
  if (speechPending && state.running && !state.settings.headphones) setStatus('Playing translation… (mic paused)');
  else if (state.running && !speechPending) updateStatusListening();
}

let listeningPaused = false;
function setListeningPaused(paused) {
  if (state.settings.headphones && paused) return;
  if (listeningPaused === paused) return;
  listeningPaused = paused;
  mic?.setMuted(paused);
  if (state.settings.engine === 'browser' && browser) paused ? browser.pause() : browser.resume();
}

// ---------------------------------------------------------------------------
// Conversation engines
// ---------------------------------------------------------------------------
let mic = null;
let whisper = null;
let browser = null;
let acceptingAudio = false;
let utteranceChain = Promise.resolve();
let lastFinalAt = 0;
let browserSeq = 0;
let levelRaf = 0;
let pendingLevel = 0;

function createMic() {
  return new MicCapture({
    getSettings: () => ({ pauseMs: Number(state.settings.pauseMs), sensitivity: Number(state.settings.sensitivity) }),
    onLevel: (lvl) => {
      pendingLevel = lvl;
      if (!levelRaf) levelRaf = requestAnimationFrame(() => { levelRaf = 0; els.meter.style.width = `${Math.round(pendingLevel * 100)}%`; });
    },
    onSpeechChange: (speaking) => {
      if (!state.running || !acceptingAudio || state.settings.engine !== 'whisper') return;
      clearInterval(partialTimer);
      if (speaking) {
        setStatus('Hearing someone', { dots: true });
        partialTimer = setInterval(maybePartial, 200);
      }
    },
    onSegment: (seg) => {
      if (!state.running || !acceptingAudio || state.settings.engine !== 'whisper') return;
      const print = voiceprint(seg.samples);
      pendingSegments++;
      utteranceChain = utteranceChain.then(() => processWhisperSegment(seg, print)).catch((err) => {
        console.error(err);
        showBanner(`Speech recognition error: ${escapeHtml(err.message)}`, { error: true, timeout: 8000 });
      });
    },
  });
}

const HALLUCINATIONS = [
  /^(\[.*\]|\(.*\)|♪+|\*.*\*)$/,
  /subtit|amara\.org|subscribe|thanks? for watching|like and subscribe|字幕|ご視聴ありがとう|продолжение следует/i,
  /^[\s.,!?¿¡…-]*$/,
  /^(you|uh|um|hmm|mm)[.!?]?$/i,
];
const isHallucination = (text) => HALLUCINATIONS.some((r) => r.test(text.trim()));

let pendingSegments = 0; // sentences waiting for (or in) final transcription

/** Who said it, given the detected language and voice. */
function pickSpeaker(language, print) {
  const forced = person(state.turnId);
  if (forced) return { p: forced, how: 'set by “My turn”' };
  let candidates = state.people.filter((p) => whisperCode(p) === language);
  if (!candidates.length) candidates = state.people;
  return {
    p: identifySpeaker(candidates, print),
    how: candidates.length === 1 ? 'detected by language' : 'detected by voice',
  };
}

const whisperLanguages = () => {
  const forced = person(state.turnId);
  return forced ? [whisperCode(forced)] : [...new Set(state.people.map(whisperCode))];
};

// --- Live previews while someone is still talking (Whisper mode) ---
let partialTimer = 0;
let partialBusy = false;
let lastPartialAt = 0;
let lastInferMs = 800;

function maybePartial() {
  if (!state.settings.livePreview || !state.running || !acceptingAudio || !mic?.inSpeech || !whisper?.ready) return;
  if (partialBusy || pendingSegments > 0) return; // finished sentences come first
  if (lastInferMs > 5000) return; // device too slow for live previews
  const now = performance.now();
  if (now - lastPartialAt < Math.max(700, lastInferMs * 1.25)) return;
  const audio = mic.currentSegment();
  if (!audio || audio.length < 16000 * 0.7) return;
  const seq = mic.segSeq;
  partialBusy = true;
  lastPartialAt = now;
  const print = voiceprint(audio);
  whisper.partial(audio, whisperLanguages())
    .then((res) => {
      lastInferMs = res.ms;
      const text = res.text.replace(/\s+/g, ' ').trim();
      // Ignore if the sentence already finished and was transcribed.
      if (!text || isHallucination(text) || !state.running || seq !== mic?.segSeq || !mic?.inSpeech && pendingSegments === 0) return;
      const { p } = pickSpeaker(res.language, print);
      if (p) showLive(p.id, text, p.lang, `w${seq}`);
    })
    .catch(() => {})
    .finally(() => { partialBusy = false; });
}

async function processWhisperSegment(seg, print) {
  try {
    if (!state.running) return;
    setStatus('Transcribing', { dots: true });
    // Stream the words into the live box of whoever the preview thought was talking.
    const key = `w${seg.seq}`;
    let streamed = '';
    const res = await whisper.transcribe(seg.samples, whisperLanguages(), {
      onText: (t) => {
        streamed += t;
        const text = streamed.replace(/\s+/g, ' ').trim();
        if (!text) return;
        if (live?.key === key) showLive(live.personId, text, live.lang, key);
        else setStatus(`Hearing: “${text}”`);
      },
    });
    const text = res.text.replace(/\s+/g, ' ').trim();
    const preview = takeLive(key);
    if (!text || isHallucination(text)) return;
    const { p, how } = pickSpeaker(res.language, print);
    if (!p) return;
    // Use the person's own language code (e.g. es-MX) for translation/display.
    addMessage(p, text, p.lang, print, how, preview);
  } finally {
    pendingSegments--;
    if (!pendingSegments && !speechPending) updateStatusListening();
  }
}

function updateStatusListening() {
  if (!state.running) return;
  if (state.settings.engine === 'whisper') {
    const forced = person(state.turnId);
    setStatus(forced
      ? `Listening to ${forced.name} only. Tap “Speaking” again for automatic detection.`
      : 'Listening. Just talk, HearClear works out who is speaking.');
  } else {
    const p = person(state.turnId);
    setStatus(p ? `Listening for ${p.name} (${getLang(p.lang).name})…` : 'Listening…');
  }
}

function setTurn(id) {
  state.turnId = id;
  updateTurnUI();
  if (state.settings.engine === 'browser' && browser && state.running) {
    clearAllLive();
    browser.setLang(person(id).lang);
  }
  updateStatusListening();
}

function onTurnClick(id) {
  if (state.settings.engine === 'whisper') {
    state.turnId = state.turnId === id ? null : id;
    updateTurnUI();
    updateStatusListening();
  } else {
    setTurn(id);
  }
}

function nextTurnAfter(id, lang) {
  const idx = state.people.findIndex((p) => p.id === id);
  const n = state.people.length;
  for (let k = 1; k < n; k++) {
    const p = state.people[(idx + k) % n];
    if (getLang(p.lang).tr !== getLang(lang).tr) return p;
  }
  return state.people[(idx + 1) % n];
}

function createBrowserEngine() {
  return new BrowserSpeechEngine({
    onInterim: (text, lang) => {
      const turn = person(state.turnId);
      if (!turn || !state.settings.livePreview) return;
      if (text) showLive(turn.id, text, lang, `b${browserSeq}`);
    },
    onFinal: (text, lang) => {
      const turn = person(state.turnId);
      if (!turn) return;
      const preview = takeLive(`b${browserSeq}`);
      browserSeq++;
      const now = performance.now();
      const audio = mic?.running ? mic.collectSpeechSince(lastFinalAt) : null;
      lastFinalAt = now;
      const print = audio && audio.length > 8000 ? voiceprint(audio) : null;
      const candidates = state.people.filter((p) => p.lang === lang);
      const p = identifySpeaker(candidates.length ? candidates : [turn], print, turn.id) || turn;
      addMessage(p, text, lang, print, candidates.length > 1 ? 'detected by voice' : null, preview);
      if (state.settings.autoTurn && state.people.length > 1) setTurn(nextTurnAfter(p.id, lang).id);
    },
    onError: (err) => {
      const msgs = {
        'not-allowed': 'Microphone access was blocked. Allow the microphone for this site and try again.',
        'service-not-allowed': 'This browser does not allow speech recognition here. Switch to “Auto-detect speakers” in Settings.',
        network: 'Browser speech recognition needs an internet connection (it uses an online service). Check your connection, or switch to “Auto-detect speakers” in Settings.',
        'language-not-supported': 'This browser cannot recognise that language. Pick another language, or switch to “Auto-detect speakers” in Settings.',
        'audio-capture': 'No microphone was found.',
      };
      showBanner(escapeHtml(msgs[err] || `Speech recognition error: ${err}`), { error: true, timeout: 10000 });
      if (err === 'not-allowed' || err === 'service-not-allowed' || err === 'audio-capture') stopConversation();
    },
  });
}

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
  setStatus(`Loading speech model… ${pct}% (${(total / 1e6).toFixed(0)} MB, saved on this device after the first time)`);
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
    if (!state.running) setStatus('Loading speech model', { dots: true });
  }
  const p = whisper.load(model, device);
  p.then(() => {
    if (!whisper.isReady(model, device)) return;
    modelLoading = false;
    storageRemove(LOAD_FLAG);
    els.progress.hidden = true;
    updateModeChip();
    if (!state.running) setStatus('Speech model ready. Press the microphone to start talking.');
  }, () => {
    modelLoading = false;
    storageRemove(LOAD_FLAG);
    els.progress.hidden = true;
  });
  return p;
}

function showModelError(err) {
  const canFallback = browserSpeechSupported();
  showBanner(`Couldn't load the on-device speech model (${escapeHtml(err?.message || err)}). <button class="btn small primary" id="retry-model">Try again</button>${canFallback ? ' <button class="btn small ghost" id="use-browser">Use browser speech instead</button>' : ''}`, { error: true });
  setStatus('Speech model not loaded');
  $('#retry-model')?.addEventListener('click', () => { hideBanner(); ensureWhisper().catch(showModelError); });
  $('#use-browser')?.addEventListener('click', () => {
    state.settings.engine = 'browser';
    save(); syncSettingsForm(); updateModeChip(); updateTurnUI(); hideBanner();
    state.turnId = state.people[0].id;
    updateTurnUI();
    setStatus('Press the microphone to start the conversation');
  });
}

/** If the tab died while the model was loading last time, step down to something lighter. Returns false to skip auto-loading. */
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
  showBanner('This device ran out of memory loading the speech model, even the smallest one. Press the microphone to try again, or switch to “Browser speech” in Settings.', { error: true });
  return false;
}

async function startConversation() {
  if (state.running || state.starting) return;
  hideBanner();
  unlockTTS();
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    showBanner('The microphone needs a secure (https) page. Open HearClear from its GitHub Pages address.', { error: true });
    return;
  }
  const engine = state.settings.engine;
  if (engine === 'browser' && !browserSpeechSupported()) {
    showBanner('This browser has no built-in speech recognition. Switched to “Auto-detect speakers”.', { error: true, timeout: 8000 });
    state.settings.engine = 'whisper';
    save();
    updateModeChip();
    updateTurnUI();
    return startConversation();
  }

  state.starting = true;
  els.mic.classList.add('busy');
  setStatus('Asking for microphone access', { dots: true });
  mic = createMic();
  try {
    await mic.start();
  } catch (err) {
    state.starting = false;
    els.mic.classList.remove('busy');
    mic = null;
    showBanner(err?.name === 'NotAllowedError'
      ? 'Microphone access was blocked. Click the lock/camera icon in the address bar, allow the microphone, then try again.'
      : `Could not open the microphone: ${escapeHtml(err?.message || err)}`, { error: true });
    setStatus('Press the microphone to start the conversation');
    return;
  }

  state.running = true;
  els.mic.setAttribute('aria-pressed', 'true');
  els.mic.setAttribute('aria-label', 'Stop conversation');

  if (engine === 'whisper') {
    acceptingAudio = false;
    state.turnId = null;
    updateTurnUI();
    if (modelLoading) setStatus('Still loading the speech model, you can start talking in a moment', { dots: true });
    try {
      await ensureWhisper();
    } catch (err) {
      state.starting = false;
      els.mic.classList.remove('busy');
      stopConversation();
      showModelError(err);
      return;
    }
    if (!state.running) { state.starting = false; els.mic.classList.remove('busy'); return; }
    acceptingAudio = true;
  } else {
    acceptingAudio = true;
    if (!person(state.turnId)) state.turnId = state.people[0].id;
    updateTurnUI();
    browser = createBrowserEngine();
    lastFinalAt = performance.now();
    browser.start(person(state.turnId).lang);
  }
  state.starting = false;
  els.mic.classList.remove('busy');
  updateStatusListening();
}

function stopConversation() {
  state.running = false;
  acceptingAudio = false;
  listeningPaused = false;
  browser?.stop();
  browser = null;
  mic?.stop();
  mic = null;
  clearInterval(partialTimer);
  clearAllLive();
  els.mic.setAttribute('aria-pressed', 'false');
  els.mic.setAttribute('aria-label', 'Start conversation');
  els.meter.style.width = '0';
  if (state.settings.engine === 'whisper') state.turnId = null;
  updateTurnUI();
  setStatus('Conversation paused. Press the microphone to continue.');
}

// ---------------------------------------------------------------------------
// Voice enrollment ("Teach voice")
// ---------------------------------------------------------------------------
const enroll = {
  dialog: $('#enroll-dialog'),
  text: $('#enroll-text'),
  phrase: $('#enroll-phrase'),
  count: $('#enroll-count'),
  go: $('#enroll-go'),
  cancel: $('#enroll-cancel'),
  personId: null,
  busy: false,
};
const ENROLL_PHRASE = 'Hello! I am teaching this app what my voice sounds like, so it knows when I am the one talking.';

async function openEnroll(id) {
  const p = person(id);
  enroll.personId = id;
  enroll.count.textContent = '';
  enroll.go.disabled = false;
  enroll.go.textContent = 'Start recording';
  enroll.text.innerHTML = `Ask <strong>${escapeHtml(p.name)}</strong> to press start and read this out loud in a normal voice. It takes 5 seconds. This helps HearClear tell people apart, especially two people who speak the same language.`;
  enroll.phrase.textContent = ENROLL_PHRASE;
  enroll.phrase.dir = 'auto';
  enroll.dialog.showModal();
  if (getLang(p.lang).tr !== 'en') {
    try { enroll.phrase.textContent = (await translate(ENROLL_PHRASE, 'en-US', p.lang, state.settings.translator)).text; } catch {}
  }
}

enroll.cancel.addEventListener('click', () => { if (!enroll.busy) enroll.dialog.close(); });
enroll.dialog.addEventListener('cancel', (e) => { if (enroll.busy) e.preventDefault(); });
enroll.go.addEventListener('click', async () => {
  const p = person(enroll.personId);
  if (!p || enroll.busy) return;
  enroll.busy = true;
  enroll.go.disabled = true;
  let tempMic = null;
  const target = mic?.running ? mic : (tempMic = createMic());
  const wasAccepting = acceptingAudio;
  acceptingAudio = false;
  browser?.pause();
  try {
    if (tempMic) await tempMic.start();
    let left = 5;
    enroll.count.textContent = `🔴 ${left}`;
    const tick = setInterval(() => { left--; enroll.count.textContent = left > 0 ? `🔴 ${left}` : '…'; }, 1000);
    const samples = await target.record(5000);
    clearInterval(tick);
    const print = voiceprint(samples);
    if (!print || print.frames < 40) {
      enroll.count.textContent = '';
      enroll.text.textContent = "Hmm, I couldn't hear enough speech. Move closer to the microphone and try again.";
      enroll.go.disabled = false;
      enroll.go.textContent = 'Try again';
    } else {
      updateProfile(p, print, { reset: true });
      p.trained = true;
      save();
      updateVoiceInfo(p);
      const g = genderFromPitch(print.f0);
      enroll.count.textContent = '✓';
      enroll.text.textContent = `Got it! ${p.name}'s voice is saved${g ? ` (sounds ${g})` : ''}.`;
      setTimeout(() => enroll.dialog.close(), 1200);
    }
  } catch (err) {
    enroll.text.textContent = `Couldn't record: ${err.message || err}`;
    enroll.go.disabled = false;
  } finally {
    tempMic?.stop();
    acceptingAudio = wasAccepting;
    if (!listeningPaused) browser?.resume();
    enroll.busy = false;
  }
});

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
  form.autoTurn.checked = s.autoTurn;
  form.translator.value = s.translator;
  form.autoSpeak.checked = s.autoSpeak;
  form.livePreview.checked = s.livePreview;
  form.rate.value = s.rate;
  form.headphones.checked = s.headphones;
  form.pauseMs.value = s.pauseMs;
  form.sensitivity.value = s.sensitivity;
  const browserRadio = form.querySelector('input[value="browser"]');
  browserRadio.disabled = !browserSpeechSupported();
  if (!browserSpeechSupported()) browserRadio.closest('.radio-card').title = 'Not supported in this browser';
  updateSettingsOutputs();
}

function updateSettingsOutputs() {
  $('#rate-out').textContent = `${Number(form.rate.value).toFixed(1)}×`;
  $('#pause-out').textContent = `${(form.pauseMs.value / 1000).toFixed(1)} s`;
  $('#sens-out').textContent = `${form.sensitivity.value}%`;
  form.querySelectorAll('[data-for]').forEach((el) => { el.hidden = el.dataset.for !== form.engine.value; });
}

form.addEventListener('input', () => {
  const s = state.settings;
  const prevEngine = s.engine;
  const prevModel = s.model;
  s.engine = form.engine.value;
  s.model = form.model.value;
  const prevDevice = s.device;
  s.device = form.device.value;
  s.autoTurn = form.autoTurn.checked;
  s.translator = form.translator.value;
  s.autoSpeak = form.autoSpeak.checked;
  s.livePreview = form.livePreview.checked;
  s.rate = Number(form.rate.value);
  s.headphones = form.headphones.checked;
  s.pauseMs = Number(form.pauseMs.value);
  s.sensitivity = Number(form.sensitivity.value);
  updateSettingsOutputs();
  updateModeChip();
  save();
  const modelChanged = s.engine === 'whisper' && (prevEngine !== s.engine || prevModel !== s.model || prevDevice !== s.device);
  if (state.running && (prevEngine !== s.engine || modelChanged)) {
    stopConversation();
    showBanner('Settings changed. Press the microphone to continue.', { timeout: 5000 });
  }
  if (modelChanged) ensureWhisper().catch(showModelError);
  if (prevEngine !== s.engine) {
    state.turnId = s.engine === 'browser' ? state.people[0].id : null;
    updateTurnUI();
  }
});

$('#settings-btn').addEventListener('click', () => { syncSettingsForm(); settingsDialog.showModal(); });
$('#reset-voices').addEventListener('click', () => {
  state.people.forEach((p) => { p.profile = null; p.trained = false; updateVoiceInfo(p); });
  save();
  showBanner('Learned voices cleared.', { timeout: 3000 });
});

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
  skipSpeech();
  state.people.forEach((p) => renderPersonMessages(p.id));
});

els.skip.addEventListener('click', skipSpeech);
els.addPerson.addEventListener('click', addPerson);
els.mic.addEventListener('click', () => (state.running || state.starting ? stopConversation() : startConversation()));
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target === document.body && $('#wizard').hidden && !document.querySelector('dialog[open]')) {
    e.preventDefault();
    els.mic.click();
  }
});

// ---------------------------------------------------------------------------
// Guided tour
// ---------------------------------------------------------------------------
const wizard = createWizard([
  {
    title: 'Welcome to HearClear 👋',
    html: `<p>HearClear lets people who speak <strong>different languages</strong> talk face to face. Put your phone or laptop between you and just talk.</p>
      <ul><li>It hears each person and works out <strong>who is speaking</strong></li>
      <li>Shows what they said in <strong>their box</strong></li>
      <li>Translates it and <strong>reads it aloud</strong> with an AI voice that matches the speaker</li></ul>
      <p>This quick tour takes about a minute.</p>`,
  },
  {
    target: '.person',
    title: 'A card for each person',
    html: `<p>Each person gets their own card. Tap the name to rename it, then pick the language they <strong>speak</strong> under <strong>Speaks</strong>.</p>
      <p>The card has two boxes. <strong>Original</strong> shows their words live as they talk. <strong>Translation</strong> shows the same sentence in the other person's language.</p>`,
  },
  {
    target: '#add-person',
    title: 'More than two people?',
    html: '<p>A conversation starts with two people. Tap <strong>Add person</strong> to add up to eight. Every message is translated into each other person\'s language.</p>',
  },
  {
    target: '.person .voice',
    title: 'Choose the AI voice',
    html: `<p>Translations are read aloud. With <strong>Auto</strong>, HearClear picks a female or male voice by measuring how high or low the speaker's voice is.</p>
      <p>You can also set <strong>Female</strong> or <strong>Male</strong> yourself.</p>`,
  },
  {
    target: '.person .enroll',
    title: 'Optional: teach it your voice',
    html: `<p>When everyone speaks a different language, HearClear tells you apart by language, so this step isn't needed.</p>
      <p>If two people share a language, tap <strong>Teach voice</strong> and read a sentence for 5 seconds. HearClear will then recognise who is talking.</p>`,
  },
  {
    target: '.person .turn',
    title: 'Fixing mistakes',
    html: `<ul><li><strong>My turn</strong> tells HearClear exactly who is talking now.</li>
      <li>Message in the wrong box? Tap <strong>⋯</strong> on it and choose <strong>Move to</strong>. HearClear learns from the correction.</li>
      <li>Tap 🔊 to hear a translation again.</li></ul>`,
  },
  {
    target: '#settings-btn',
    title: 'Two ways to listen',
    html: `<p><strong>Auto-detect speakers</strong> (default) runs the Whisper AI model on your device. It downloads once (about 80&nbsp;MB) and then works out the language and the speaker by itself.</p>
      <p><strong>Browser speech</strong> is faster and needs no download (Chrome, Edge, Safari). It listens for one person at a time and passes the turn on after each sentence.</p>`,
  },
  {
    target: '#mic-btn',
    title: 'Press the microphone and talk',
    html: `<ul><li>Allow microphone access when your browser asks.</li>
      <li>Speak naturally, one person at a time. <strong>Pause briefly</strong> when you finish a sentence.</li>
      <li>The mic pauses while the AI voice talks, so it doesn't translate itself. With headphones you can turn that off in Settings.</li>
      <li>Quiet rooms work best.</li></ul>`,
  },
], {
  onFinish: (finished) => {
    storageSet(TOUR_KEY, '1');
    if (finished) els.mic.focus();
  },
});
$('#guide-btn').addEventListener('click', () => wizard.start());

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
load();
renderPeople();
syncSettingsForm();
updateModeChip();
if (!storageGet(TOUR_KEY)) setTimeout(() => wizard.start(), 400);
navigator.storage?.persist?.().catch(() => {}); // keep the cached model from being evicted
// A normal refresh/close while loading is not a crash.
window.addEventListener('pagehide', () => { if (modelLoading) storageRemove(LOAD_FLAG); });
// Finish translations that were in flight when the page was closed.
state.messages.filter((m) => targetLangs(m).some((t) => m.translations[t]?.status !== 'done')).forEach((m) => translateMessage(m));
if (state.settings.engine === 'whisper') {
  if (checkCrashGuard()) ensureWhisper().catch(showModelError);
} else {
  state.turnId = state.people[0].id;
  updateTurnUI();
}
if (!ttsSupported()) showBanner('This browser cannot play AI voices. Translations will still be shown as text.', { timeout: 8000 });
window.hearclear = { state }; // handy for debugging
