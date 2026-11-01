# HearClear

Live voice translation for face-to-face conversations between people who speak different languages. It runs entirely in the browser on GitHub Pages, with no server and no API keys.

**Live app:** https://mngvn.github.io/hearclear/

## What it does

1. Press the microphone and talk. HearClear starts with **two people** and you can **add up to eight**.
2. It hears each sentence and works out **who is speaking**, then shows the words in **that person's box**.
3. It **translates** the sentence into every other person's language and shows it underneath.
4. It **reads the translation aloud** with an AI voice of the **same gender** as the speaker. The gender is detected from the pitch of the speaker's voice, or you can set it yourself.

A guided tour opens on the first visit. Reopen it any time with **Guide** in the top bar.

## How speaker detection works

| Mode | How it decides who's talking | Notes |
| --- | --- | --- |
| **Auto-detect speakers** (default) | Runs [Whisper](https://github.com/openai/whisper) on your device via [transformers.js](https://github.com/huggingface/transformers.js). For each sentence it detects which of the *participants'* languages is spoken, which picks the person. If several people share a language, it compares voice fingerprints (pitch and spectral features). | The model downloads once (~40–250 MB depending on size) and is cached. Uses WebGPU when available, otherwise WebAssembly. Works in Chrome, Edge, Safari and Firefox. |
| **Browser speech** (turn-taking) | Uses the browser's Web Speech API in the current person's language, then passes the turn to the next person after each sentence. Voice fingerprints decide between people who share a language. | Fast, nothing to download. Chrome, Edge and Safari only. |

Fixing mistakes:

- **My turn** tells HearClear exactly who is speaking.
- **⋯ → Move to** moves a message to the right person. HearClear also learns that person's voice from it.
- **Teach voice** records a 5-second sample. This helps most when two people share a language.

## Translation and voices

- Translation: Google Translate's free web endpoint, with MyMemory as a fallback. Chrome's on-device Translator API is available as an option in Settings.
- Voices: the browser's built-in speech synthesis. HearClear picks a voice in the target language whose name suggests the right gender. If none exists, it shifts the pitch instead.
- The microphone pauses while the AI voice talks, so the app doesn't translate itself. If everyone wears headphones, you can turn that off in Settings.

## Privacy

Audio never leaves the device in Auto-detect mode. The translation requests send the text to the selected translation service. Browser speech mode uses your browser vendor's speech service (Chrome, for example, sends audio to Google).

## Development

The app is plain HTML, CSS and ES modules with no build step:

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

The microphone only works on `https://` or `localhost`.

```
index.html            page structure (people, controls, settings, tour)
css/styles.css        styles (light & dark)
js/app.js             app state, UI, conversation pipeline
js/audio.js           mic capture, voice activity detection, voiceprints (pitch + MFCC)
js/speaker.js         speaker matching & gender from pitch
js/engines.js         Whisper engine wrapper + Web Speech API engine
js/whisper-worker.js  Whisper in a Web Worker, with language detection limited to the participants' languages
js/translate.js       translation providers with fallback
js/tts.js             gender-matched speech synthesis
js/wizard.js          guided tour
js/languages.js       supported languages
```

Each push to `main` deploys to GitHub Pages through `.github/workflows/pages.yml`, which publishes to the `gh-pages` branch.
