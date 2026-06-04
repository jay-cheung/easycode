import { appendOutput } from "./runner-helpers"

export function runFailureText(text: string, reason: "provider_error" | "max_steps") {
  const trimmed = text.trim()
  const guidance = reason === "max_steps"
    ? "Continue with another message to keep going."
    : "Run failed. Continue with another message to retry or provide more direction."
  return appendOutput(trimmed, guidance)
}
