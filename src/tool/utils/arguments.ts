export type InvalidProviderToolArguments = {
  __easycodeInvalidToolArguments: true
  code: "invalid_tool_arguments"
  message: string
  tool: string
  callID?: string
  arguments: string
}

export function parseProviderToolArguments(rawArguments: string, toolName: string, callID: string | undefined) {
  try {
    return { ok: true as const, input: JSON.parse(rawArguments) as unknown }
  } catch (error) {
    const message = `Invalid tool arguments from provider for ${toolName}: ${error instanceof Error ? error.message : String(error)}`
    return {
      ok: false as const,
      input: { __easycodeInvalidToolArguments: true, code: "invalid_tool_arguments", message, tool: toolName, callID, arguments: rawArguments } satisfies InvalidProviderToolArguments,
    }
  }
}

export function invalidProviderToolArguments(input: unknown) {
  if (!isInvalidProviderToolArguments(input)) return undefined
  return `${input.message}\nRaw arguments: ${input.arguments}`
}

function isInvalidProviderToolArguments(input: unknown): input is InvalidProviderToolArguments {
  return Boolean(
    input &&
      typeof input === "object" &&
      "__easycodeInvalidToolArguments" in input &&
      (input as { __easycodeInvalidToolArguments?: unknown }).__easycodeInvalidToolArguments === true &&
      typeof (input as { message?: unknown }).message === "string" &&
      typeof (input as { arguments?: unknown }).arguments === "string",
  )
}
