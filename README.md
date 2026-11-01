# HearClear

Live voice translation for face-to-face conversations between people who speak different languages. It runs entirely in the browser on GitHub Pages, with no server and no API keys.

**Live app:** https://mngvn.github.io/hearclear/

## How to use it

1. Each person has a card. Set their name and the language they **speak**. There are two people to start, and you can add up to eight.
2. Tap **🎙️ Talk** on your card and speak. Your words appear **live** in the **Original** box, and the translation appears live in the **Translation** box.
3. Tap the same button again to **save** what you said.
4. Press **🔊 Play** on the translation so the other person **hears** it, read by an AI voice. With *Auto*, the voice's gender matches yours, judged from the pitch of your voice.

A guided tour opens on the first visit. Reopen it any time with **Guide** in the top bar.

## Speech recognition

| Option | Notes |
| --- | --- |
| **On-device AI** (default) | Runs [Whisper](https://github.com/openai/whisper) in the browser via [transformers.js](https://github.com/huggingface/transformers.js). It loads automatically when the page opens and is cached after the first download (~40–250 MB depending on size). While you talk, it previews the unfinished sentence about once a second, and it locks in each sentence when you pause. Uses WebGPU on computers and the CPU on phones (less memory). If the tab crashes while loading, it steps down to a lighter setup on its own. |
| **Browser speech** | The browser's Web Speech API (Chrome, Edge, Safari). The fastest live words and nothing to download, but the audio goes to the browser maker's service. |

## Translation and voices

- Translation: Google Translate's free web endpoint, with MyMemory as a fallback. Chrome's on-device Translator API is available as an option in Settings.
- Voices: the browser's built-in speech synthesis. HearClear picks a voice in the target language whose name suggests the right gender. If none exists, it shifts the pitch instead.
- Translations play when you press 🔊 Play. To play them automatically after saving, turn that on in Settings.

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
js/audio.js           mic capture, sentence detection, voice pitch
js/speaker.js         voice profile & gender from pitch
js/engines.js         Whisper engine wrapper + push-to-talk Web Speech API engine
js/whisper-worker.js  Whisper in a Web Worker (live previews, streamed words)
js/translate.js       translation providers with fallback
js/tts.js             gender-matched speech synthesis
js/wizard.js          guided tour
js/languages.js       supported languages
```

Each push to `main` deploys to GitHub Pages through `.github/workflows/pages.yml`, which publishes to the `gh-pages` branch.
