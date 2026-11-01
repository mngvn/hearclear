// Text-to-speech with gender-matched voices (Web Speech Synthesis API).
// Browsers don't report a voice's gender, so we infer it from the voice name.

const FEMALE = /female|woman|girl|\b(samantha|victoria|karen|moira|tessa|fiona|veena|allison|ava|susan|zira|aria|jenny|michelle|sonia|libby|hazel|heera|monica|mónica|paulina|luciana|joana|amelie|amélie|audrey|aurelie|aurélie|marie|anna|petra|helena|laura|alice|federica|elsa|kyoko|o-ren|mei-jia|sin-ji|ting-ting|tingting|yuna|milena|katya|ioana|zuzana|ellen|sara|nora|alva|klara|satu|mariska|yelda|carmit|lekha|damayanti|kanya|linh|lesya|amira|laila|mariam|salma|hoda|xiaoxiao|huihui|yaoyao|xiaoyi|nanami|ayumi|haruka|sun-hi|heami|denise|elvira|dalia|francisca|paloma|isabela|elena|katja|hedda|seraphina|ines|inês|emma|olivia|natasha|clara|catherine|kate|serena|martha|nicky|flo|sandy|shelley|grandma|kathy|vicki|zosia|ewa|agnieszka|aditi|raveena|swara|neerja|ana|camila|lucia|lucía|conchita|penelope|lupe|mia|lea|léa|celine|céline|chantal|vicki|marlene|giorgia|bianca|carla|dora|hanna|tatyana|svetlana|dariya|zeynep|filiz|hiujin|hiumaan|aigerim|premwadee|achara|hoaimy|gadis|yasmin|shirin|dilara|salome|gul)\b/i;
const MALE = /\bmale\b|\bman\b|\b(alex|daniel|fred|tom|aaron|arthur|gordon|lee|oliver|rishi|thomas|jorge|diego|juan|carlos|luca|felipe|xander|yannick|markus|otoya|ichiro|keita|kangkang|yunxi|yunyang|yunjian|david|mark|george|james|guy|ryan|eric|christopher|andrew|brian|roger|pablo|alvaro|álvaro|raul|raúl|henri|paul|claude|stefan|conrad|killian|cosimo|antonio|dariusz|pavel|maxim|yuri|hamed|naayf|ahmed|kenji|hyunsu|injoon|tarik|filip|jakub|bruno|matthew|joey|justin|kevin|russell|geraint|brian|enrique|miguel|mathieu|hans|giorgio|takumi|liam|william|ravi|prabhat|madhur|hemant|valluvar|nam|ardi|farid|davit|dmitry|ivan|cem|ahmet|wan|niranjan|reed|rocko|eddy|ralph|albert|bubbles|junior|grandpa|jacques|ferhat|gyorgy|vit|jorn|magnus|thierry|nicolas)\b/i;
const QUALITY = /natural|neural|premium|enhanced|online|google|siri/i;

let voices = [];
function refresh() { voices = window.speechSynthesis?.getVoices() || []; }
if ('speechSynthesis' in window) {
  refresh();
  window.speechSynthesis.addEventListener?.('voiceschanged', refresh);
}

export const ttsSupported = () => 'speechSynthesis' in window;

export function voiceGender(v) {
  const n = v.name;
  if (/female/i.test(n)) return 'female';
  if (/\bmale\b/i.test(n)) return 'male';
  if (FEMALE.test(n)) return 'female';
  if (MALE.test(n)) return 'male';
  // Google's Chrome voices without a gender label are female.
  if (/^Google/i.test(n)) return 'female';
  return null;
}

export function voicesFor(langCode) {
  if (!voices.length) refresh();
  const norm = (s) => s.replace('_', '-').toLowerCase();
  const exact = voices.filter((v) => norm(v.lang) === langCode.toLowerCase());
  const base = langCode.split('-')[0].toLowerCase();
  const alias = { fil: 'tl', nb: 'no', he: 'iw' }; // some engines use legacy codes
  const loose = voices.filter((v) => {
    const b = norm(v.lang).split('-')[0];
    return b === base || b === alias[base] || alias[b] === base;
  });
  return exact.length ? [...exact, ...loose.filter((v) => !exact.includes(v))] : loose;
}

/** Best voice for a language & gender. Returns {voice, pitch} where pitch compensates when no match exists. */
export function pickVoice(langCode, gender) {
  const list = voicesFor(langCode);
  if (!list.length) return { voice: null, pitch: 1 };
  const score = (v) => {
    let s = 0;
    const g = voiceGender(v);
    if (gender && g === gender) s += 10;
    else if (gender && g && g !== gender) s -= 10;
    if (v.lang.replace('_', '-').toLowerCase() === langCode.toLowerCase()) s += 3;
    if (QUALITY.test(v.name)) s += 2;
    if (v.localService) s += 0.5;
    return s;
  };
  const best = [...list].sort((a, b) => score(b) - score(a))[0];
  const g = voiceGender(best);
  let pitch = 1;
  // No voice of the right gender for this language? Shift the pitch instead.
  if (gender && g && g !== gender) pitch = gender === 'male' ? 0.6 : 1.4;
  return { voice: best, pitch };
}

let unlocked = false;
/** iOS/Safari only allow speech after a user gesture; call from a click handler. */
export function unlockTTS() {
  if (unlocked || !ttsSupported()) return;
  unlocked = true;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  window.speechSynthesis.speak(u);
}

export function cancelSpeech() {
  if (ttsSupported()) window.speechSynthesis.cancel();
}

/** Speak and resolve when finished (or after a safety timeout). */
export function speak(text, langCode, gender, { rate = 1 } = {}) {
  return new Promise((resolve) => {
    if (!ttsSupported() || !text) return resolve();
    const { voice, pitch } = pickVoice(langCode, gender);
    const u = new SpeechSynthesisUtterance(text);
    u.lang = voice?.lang || langCode;
    if (voice) u.voice = voice;
    u.pitch = pitch;
    u.rate = rate;
    let done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
    // Some browsers occasionally never fire 'end'.
    const timer = setTimeout(finish, 4000 + (text.length * 120) / rate);
    u.onend = finish;
    u.onerror = finish;
    window.speechSynthesis.speak(u);
  });
}
