import english from "./en"
import { buildChineseCopy } from "./zh"
import { buildJapaneseCopy } from "./ja"
import { buildFrenchCopy } from "./fr"
import { buildKoreanCopy } from "./ko"
import { buildGermanCopy } from "./de"
import { uiLanguages, type UiLanguage, type UiCopy } from "./types"

export { uiLanguages, type UiLanguage, type UiCopy, type SlashErrorCode } from "./types"

const languageLabels: Record<UiLanguage, string> = {
  en: "English",
  zh: "中文",
  ja: "日本語",
  fr: "Français",
  ko: "한국어",
  de: "Deutsch",
}

const localeMap: Record<UiLanguage, string> = {
  en: "en-US",
  zh: "zh-CN",
  ja: "ja-JP",
  fr: "fr-FR",
  ko: "ko-KR",
  de: "de-DE",
}

const aliases: Record<string, UiLanguage> = {
  en: "en",
  english: "en",
  zh: "zh",
  "zh-cn": "zh",
  "zh-hans": "zh",
  cn: "zh",
  chinese: "zh",
  "中文": "zh",
  ja: "ja",
  jp: "ja",
  japanese: "ja",
  "日本語": "ja",
  fr: "fr",
  french: "fr",
  francais: "fr",
  "français": "fr",
  ko: "ko",
  kr: "ko",
  korean: "ko",
  "한국어": "ko",
  de: "de",
  german: "de",
  deutsch: "de",
}

function languageLabel(language: UiLanguage) {
  return languageLabels[language]
}

function languageLocale(language: UiLanguage) {
  return localeMap[language]
}

function supportedLanguageSummary() {
  return uiLanguages.map((language) => `${language} (${languageLabel(language)})`).join(", ")
}

function normalizeUiLanguage(value: string | undefined | null, fallback: UiLanguage = "en"): UiLanguage {
  if (!value) return fallback
  const normalized = aliases[value.trim().toLowerCase()]
  return normalized ?? fallback
}

function parseUiLanguage(value: string | undefined | null) {
  if (!value) return undefined
  return aliases[value.trim().toLowerCase()]
}

function detectUiLanguage(env: Record<string, string | undefined> = process.env): UiLanguage {
  const configured = parseUiLanguage(env.EASYCODE_LANG)
  if (configured) return configured
  const locale = (env.LC_ALL || env.LC_MESSAGES || env.LANG || Intl.DateTimeFormat().resolvedOptions().locale || "").toLowerCase()
  if (locale.startsWith("zh")) return "zh"
  if (locale.startsWith("ja")) return "ja"
  if (locale.startsWith("fr")) return "fr"
  if (locale.startsWith("ko")) return "ko"
  if (locale.startsWith("de")) return "de"
  return "en"
}

function formatLanguageChoices() {
  return uiLanguages.map((language) => `${language} (${languageLabel(language)})`).join(", ")
}

export { languageLabel, languageLocale, supportedLanguageSummary, normalizeUiLanguage, parseUiLanguage, detectUiLanguage }

const copies: Record<UiLanguage, UiCopy> = {
  en: english,
  zh: buildChineseCopy(english),
  ja: buildJapaneseCopy(english),
  fr: buildFrenchCopy(english),
  ko: buildKoreanCopy(english),
  de: buildGermanCopy(english),
}

export function uiText(language: UiLanguage | string | undefined) {
  return copies[normalizeUiLanguage(typeof language === "string" ? language : language ?? "en")]
}

export function languageDisplay(language: UiLanguage | string | undefined) {
  const normalized = normalizeUiLanguage(typeof language === "string" ? language : language ?? "en")
  return `${normalized} (${languageLabel(normalized)})`
}

export function uiLanguageChoices() {
  return formatLanguageChoices()
}
