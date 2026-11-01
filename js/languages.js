// Supported languages.
//  code    – BCP-47 tag used for browser speech recognition + speech synthesis
//  whisper – Whisper language code (used for auto language detection)
//  tr      – code used by the translation services
export const LANGUAGES = [
  { code: 'en-US', name: 'English (US)', native: 'English', whisper: 'en', tr: 'en' },
  { code: 'en-GB', name: 'English (UK)', native: 'English', whisper: 'en', tr: 'en' },
  { code: 'es-ES', name: 'Spanish (Spain)', native: 'Español', whisper: 'es', tr: 'es' },
  { code: 'es-MX', name: 'Spanish (Mexico)', native: 'Español', whisper: 'es', tr: 'es' },
  { code: 'fr-FR', name: 'French', native: 'Français', whisper: 'fr', tr: 'fr' },
  { code: 'de-DE', name: 'German', native: 'Deutsch', whisper: 'de', tr: 'de' },
  { code: 'it-IT', name: 'Italian', native: 'Italiano', whisper: 'it', tr: 'it' },
  { code: 'pt-BR', name: 'Portuguese (Brazil)', native: 'Português', whisper: 'pt', tr: 'pt' },
  { code: 'pt-PT', name: 'Portuguese (Portugal)', native: 'Português', whisper: 'pt', tr: 'pt' },
  { code: 'zh-CN', name: 'Chinese (Mandarin)', native: '中文', whisper: 'zh', tr: 'zh-CN' },
  { code: 'zh-TW', name: 'Chinese (Taiwan)', native: '中文 (台灣)', whisper: 'zh', tr: 'zh-TW' },
  { code: 'yue-HK', name: 'Cantonese', native: '粵語', whisper: 'yue', tr: 'yue' },
  { code: 'ja-JP', name: 'Japanese', native: '日本語', whisper: 'ja', tr: 'ja' },
  { code: 'ko-KR', name: 'Korean', native: '한국어', whisper: 'ko', tr: 'ko' },
  { code: 'ru-RU', name: 'Russian', native: 'Русский', whisper: 'ru', tr: 'ru' },
  { code: 'uk-UA', name: 'Ukrainian', native: 'Українська', whisper: 'uk', tr: 'uk' },
  { code: 'ar-SA', name: 'Arabic', native: 'العربية', whisper: 'ar', tr: 'ar', rtl: true },
  { code: 'he-IL', name: 'Hebrew', native: 'עברית', whisper: 'he', tr: 'iw', rtl: true },
  { code: 'fa-IR', name: 'Persian', native: 'فارسی', whisper: 'fa', tr: 'fa', rtl: true },
  { code: 'ur-PK', name: 'Urdu', native: 'اردو', whisper: 'ur', tr: 'ur', rtl: true },
  { code: 'hi-IN', name: 'Hindi', native: 'हिन्दी', whisper: 'hi', tr: 'hi' },
  { code: 'bn-IN', name: 'Bengali', native: 'বাংলা', whisper: 'bn', tr: 'bn' },
  { code: 'ta-IN', name: 'Tamil', native: 'தமிழ்', whisper: 'ta', tr: 'ta' },
  { code: 'vi-VN', name: 'Vietnamese', native: 'Tiếng Việt', whisper: 'vi', tr: 'vi' },
  { code: 'th-TH', name: 'Thai', native: 'ไทย', whisper: 'th', tr: 'th' },
  { code: 'id-ID', name: 'Indonesian', native: 'Bahasa Indonesia', whisper: 'id', tr: 'id' },
  { code: 'ms-MY', name: 'Malay', native: 'Bahasa Melayu', whisper: 'ms', tr: 'ms' },
  { code: 'fil-PH', name: 'Filipino', native: 'Filipino', whisper: 'tl', tr: 'tl' },
  { code: 'tr-TR', name: 'Turkish', native: 'Türkçe', whisper: 'tr', tr: 'tr' },
  { code: 'pl-PL', name: 'Polish', native: 'Polski', whisper: 'pl', tr: 'pl' },
  { code: 'nl-NL', name: 'Dutch', native: 'Nederlands', whisper: 'nl', tr: 'nl' },
  { code: 'sv-SE', name: 'Swedish', native: 'Svenska', whisper: 'sv', tr: 'sv' },
  { code: 'nb-NO', name: 'Norwegian', native: 'Norsk', whisper: 'no', tr: 'no' },
  { code: 'da-DK', name: 'Danish', native: 'Dansk', whisper: 'da', tr: 'da' },
  { code: 'fi-FI', name: 'Finnish', native: 'Suomi', whisper: 'fi', tr: 'fi' },
  { code: 'el-GR', name: 'Greek', native: 'Ελληνικά', whisper: 'el', tr: 'el' },
  { code: 'cs-CZ', name: 'Czech', native: 'Čeština', whisper: 'cs', tr: 'cs' },
  { code: 'ro-RO', name: 'Romanian', native: 'Română', whisper: 'ro', tr: 'ro' },
  { code: 'hu-HU', name: 'Hungarian', native: 'Magyar', whisper: 'hu', tr: 'hu' },
  { code: 'sw-KE', name: 'Swahili', native: 'Kiswahili', whisper: 'sw', tr: 'sw' },
];

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));

export function getLang(code) {
  return BY_CODE.get(code) || LANGUAGES[0];
}

// Order used when new people are added to the conversation.
export const DEFAULT_LANG_ROTATION = ['en-US', 'es-MX', 'fr-FR', 'de-DE', 'zh-CN', 'ja-JP', 'ar-SA', 'hi-IN', 'pt-BR', 'ko-KR'];
