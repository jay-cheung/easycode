import { spawn } from "node:child_process"
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

export const devApplicationName = "easycode"
export const devBundleIdentityVersion = "8"
export const devBundleIdentifier = `dev.easycode.desktop.dev.${devBundleIdentityVersion}`

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(scriptDir, "..")
const require = createRequire(import.meta.url)

export function electronExecutablePath() {
  return require("electron")
}

export function electronMacAppPath(executablePath) {
  const marker = `${path.sep}Contents${path.sep}MacOS${path.sep}`
  const index = executablePath.indexOf(marker)
  if (index < 0) throw new Error(`Electron executable is not inside a macOS app bundle: ${executablePath}`)
  return executablePath.slice(0, index)
}

export function patchMacInfoPlist(text, name = devApplicationName) {
  const withStringKey = (input, key, value) => {
    const keyPattern = new RegExp(`(<key>${key}</key>\\s*<string>)([^<]*)(</string>)`)
    if (keyPattern.test(input)) return input.replace(keyPattern, `$1${value}$3`)
    return insertTopLevelPlistString(input, key, value)
  }

  return [
    ["CFBundleDisplayName", name],
    ["CFBundleName", name],
    ["CFBundleIdentifier", devBundleIdentifier],
    ["CFBundleIconFile", "electron.icns"],
    ["CFBundleVersion", devBundleIdentityVersion],
    ["CFBundleShortVersionString", `0.0.${devBundleIdentityVersion}`],
  ].reduce((input, [key, value]) => withStringKey(input, key, value), text)
}

export function patchMacHelperInfoPlist(text, name = devApplicationName) {
  const helperName = text.match(/<key>CFBundleName<\/key>\s*<string>([^<]*)<\/string>/)?.[1] ?? `${name} Helper`
  const suffix = helperName.startsWith("Electron Helper")
    ? helperName.slice("Electron Helper".length)
    : helperName.startsWith(`${name} Helper`)
      ? helperName.slice(`${name} Helper`.length)
      : ""
  const helperIdSuffix = suffix.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "")
  const helperId = `${devBundleIdentifier}.helper${helperIdSuffix ? `.${helperIdSuffix}` : ""}`
  return [
    ["CFBundleName", `${name} Helper${suffix}`],
    ["CFBundleDisplayName", `${name} Helper${suffix}`],
    ["CFBundleIdentifier", helperId],
  ].reduce((input, [key, value]) => {
    const keyPattern = new RegExp(`(<key>${key}</key>\\s*<string>)([^<]*)(</string>)`)
    if (keyPattern.test(input)) return input.replace(keyPattern, `$1${value}$3`)
    return insertTopLevelPlistString(input, key, value)
  }, text)
}

function insertTopLevelPlistString(text, key, value) {
  const index = text.lastIndexOf("</dict>")
  if (index < 0) return text
  return `${text.slice(0, index)}\t<key>${key}</key>\n\t<string>${value}</string>\n${text.slice(index)}`
}

export function patchMacLocalizedInfoPlistStrings(text, name = devApplicationName) {
  const withLocalizedKey = (input, key, value) => {
    const quotedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const keyPattern = new RegExp(`("${quotedKey}"\\s*=\\s*")([^"]*)(";?)`)
    if (keyPattern.test(input)) return input.replace(keyPattern, `$1${value}$3`)
    return `${input.trimEnd()}\n"${key}" = "${value}";\n`
  }

  return [
    "CFBundleDisplayName",
    "CFBundleName",
  ].reduce((input, key) => withLocalizedKey(input, key, name), text)
}

function patchLocalizedInfoPlistStrings(appPath, name) {
  const resourcesDir = path.join(appPath, "Contents", "Resources")
  if (!existsSync(resourcesDir)) return
  for (const entry of readdirSync(resourcesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".lproj")) continue
    const stringsPath = path.join(resourcesDir, entry.name, "InfoPlist.strings")
    if (!existsSync(stringsPath)) continue
    const strings = readFileSync(stringsPath, "utf8")
    const patched = patchMacLocalizedInfoPlistStrings(strings, name)
    if (patched !== strings) writeFileSync(stringsPath, patched)
  }
}

export function ensureMacDevApp(sourceApp, options = {}) {
  const name = options.name ?? devApplicationName
  const targetRoot = options.targetRoot ?? path.join(appDir, ".easycode-electron")
  const targetApp = path.join(targetRoot, "Electron.app")
  const legacyTargetApp = path.join(targetRoot, `${name}.app`)
  const marker = path.join(targetRoot, "source.txt")
  const iconPath = path.join(appDir, "build", "icon.icns")
  const sourceMarker = `${sourceApp}\n${name}\n${devBundleIdentityVersion}\n${iconSignature(iconPath)}\n`

  if (legacyTargetApp !== targetApp) rmSync(legacyTargetApp, { recursive: true, force: true })

  if (!existsSync(targetApp) || !existsSync(marker) || readFileSync(marker, "utf8") !== sourceMarker) {
    rmSync(targetApp, { recursive: true, force: true })
    mkdirSync(targetRoot, { recursive: true })
    cpSync(sourceApp, targetApp, { recursive: true })
    writeFileSync(marker, sourceMarker)
  }

  const plistPath = path.join(targetApp, "Contents", "Info.plist")
  const plist = readFileSync(plistPath, "utf8")
  const patched = patchMacInfoPlist(plist, name)
  if (patched !== plist) writeFileSync(plistPath, patched)
  patchLocalizedInfoPlistStrings(targetApp, name)

  const resourcesIconPath = path.join(targetApp, "Contents", "Resources", "electron.icns")
  if (existsSync(iconPath)) {
    mkdirSync(path.dirname(resourcesIconPath), { recursive: true })
    copyFileSync(iconPath, resourcesIconPath)
  }

  const executableDir = path.join(targetApp, "Contents", "MacOS")
  const sourceExecutable = path.join(executableDir, path.basename(electronExecutablePath()))

  return {
    appPath: targetApp,
    executablePath: sourceExecutable,
  }
}

function iconSignature(iconPath) {
  if (!existsSync(iconPath)) return "no-icon"
  const stat = statSync(iconPath)
  return `${iconPath}:${stat.size}:${Math.trunc(stat.mtimeMs)}`
}

export function devElectronCommand(platform = process.platform) {
  return { command: electronExecutablePath(), args: [appDir] }
}

function run() {
  const { command, args } = devElectronCommand()
  const child = spawn(command, args, {
    cwd: appDir,
    env: process.env,
    stdio: "inherit",
  })

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal))
  }

  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exit(code ?? 0)
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run()
