// Lightweight speaker identification built on the voiceprints from audio.js.
// Each person keeps a running-average profile {vec, f0, n}. A new utterance is
// matched to the closest profile; if it is far from everyone and someone in the
// conversation has not spoken yet, it is treated as that new person.

const NEW_SPEAKER_DISTANCE = 1.15;
const MALE_FEMALE_SPLIT_HZ = 165;

export function voiceDistance(profile, print) {
  if (!profile || !print) return Infinity;
  let d = 0;
  const n = Math.min(profile.vec.length, print.vec.length);
  // MFCC distance; higher-order coefficients are smaller, so weight by index.
  for (let i = 0; i < n; i++) {
    const w = 1 + i * 0.15;
    const diff = (profile.vec[i] - print.vec[i]) * w;
    d += diff * diff;
  }
  d = Math.sqrt(d / n) / 6; // ~0.3–0.7 same speaker, >1 different (empirical)
  if (profile.f0 && print.f0) d += Math.abs(Math.log2(print.f0 / profile.f0)) * 2.2;
  return d;
}

export function updateProfile(person, print, { reset = false } = {}) {
  if (!print) return;
  if (reset || !person.profile) {
    person.profile = { vec: print.vec.slice(), f0: print.f0 || 0, n: reset ? 3 : 1 };
    return;
  }
  const p = person.profile;
  const w = 1 / Math.min(p.n + 1, 8); // adapt slowly once we know the voice
  p.vec = p.vec.map((v, i) => v * (1 - w) + print.vec[i] * w);
  if (print.f0) p.f0 = p.f0 ? p.f0 * (1 - w) + print.f0 * w : print.f0;
  p.n++;
}

/**
 * Pick which person spoke.
 * @param {Array} candidates people that could have said it (e.g. same language)
 * @param {object|null} print voiceprint of the utterance
 * @param {string|null} preferredId person to favour when voices are ambiguous
 */
export function identifySpeaker(candidates, print, preferredId = null) {
  if (!candidates.length) return null;
  if (candidates.length === 1 || !print) {
    return candidates.find((c) => c.id === preferredId) || candidates[0];
  }
  const known = candidates.filter((c) => c.profile);
  const unknown = candidates.filter((c) => !c.profile);
  if (!known.length) return unknown.find((c) => c.id === preferredId) || unknown[0];

  let best = null, bestD = Infinity;
  for (const c of known) {
    let d = voiceDistance(c.profile, print);
    if (c.id === preferredId) d -= 0.1;
    if (d < bestD) { bestD = d; best = c; }
  }
  if (bestD > NEW_SPEAKER_DISTANCE && unknown.length) return unknown[0];
  return best;
}

/** 'female' | 'male' | null from a pitch in Hz. */
export function genderFromPitch(f0) {
  if (!f0) return null;
  return f0 >= MALE_FEMALE_SPLIT_HZ ? 'female' : 'male';
}
