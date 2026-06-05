import type { UiLanguage } from "../../i18n"

export type Writable = {
  write(text: string): unknown
  isTTY?: boolean
  columns?: number
}

export type TuiContext = {
  root: string
  mode: string
  provider: string
  model?: string
  language?: UiLanguage
  session?: string
  logger?: boolean
}
