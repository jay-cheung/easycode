export const desktopCapabilityUnitTests: string[]

export const desktopCapabilityIntegrationPattern: string

export const desktopCapabilityCommands: Array<{
  name: string
  command: string
  args: string[]
}>

export function runDesktopCapabilityVerification(commands?: typeof desktopCapabilityCommands): number
