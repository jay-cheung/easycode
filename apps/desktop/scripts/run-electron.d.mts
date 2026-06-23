export const devApplicationName: "easycode"

export const devBundleIdentityVersion: string

export const devBundleIdentifier: string

export function electronExecutablePath(): string

export function electronMacAppPath(executablePath: string): string

export function patchMacInfoPlist(text: string, name?: string): string

export function patchMacHelperInfoPlist(text: string, name?: string): string

export function patchMacLocalizedInfoPlistStrings(text: string, name?: string): string

export function ensureMacDevApp(
  sourceApp: string,
  options?: { name?: string, targetRoot?: string },
): { appPath: string, executablePath: string }

export function devElectronCommand(platform?: NodeJS.Platform): { command: string, args: string[] }
