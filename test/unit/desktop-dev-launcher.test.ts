import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  devBundleIdentifier,
  devBundleIdentityVersion,
  devElectronCommand,
  electronMacAppPath,
  ensureMacDevApp,
  patchMacLocalizedInfoPlistStrings,
  patchMacHelperInfoPlist,
  patchMacInfoPlist,
} from "../../apps/desktop/scripts/run-electron.mjs"

describe("desktop dev launcher", () => {
  const tempRoots: string[] = []

  afterEach(() => {
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  test("finds the app bundle that owns a macOS Electron executable", () => {
    expect(electronMacAppPath("/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")).toBe("/repo/node_modules/electron/dist/Electron.app")
  })

  test("uses the original Electron app for macOS dev launches to preserve Chromium resources", () => {
    const command = devElectronCommand("darwin")

    expect(command.command).toContain(path.join("node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron"))
    expect(command.command).not.toContain(".easycode-electron")
    expect(command.args.at(-1)).toContain(path.join("apps", "desktop"))
  })

  test("renames the macOS development app bundle metadata", () => {
    const plist = [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<plist version=\"1.0\">",
      "<dict>",
      "\t<key>CFBundleName</key>",
      "\t<string>Electron</string>",
      "\t<key>CFBundleDisplayName</key>",
      "\t<string>Electron</string>",
      "\t<key>CFBundleExecutable</key>",
      "\t<string>Electron</string>",
      "\t<key>CFBundleIdentifier</key>",
      "\t<string>org.electronjs.Electron</string>",
      "</dict>",
      "</plist>",
    ].join("\n")

    const patched = patchMacInfoPlist(plist, "easycode")

    expect(patched).toContain("<key>CFBundleName</key>\n\t<string>easycode</string>")
    expect(patched).toContain("<key>CFBundleDisplayName</key>\n\t<string>easycode</string>")
    expect(patched).toContain("<key>CFBundleExecutable</key>\n\t<string>Electron</string>")
    expect(patched).toContain(`<key>CFBundleIdentifier</key>\n\t<string>${devBundleIdentifier}</string>`)
    expect(patched).toContain("<key>CFBundleIconFile</key>\n\t<string>electron.icns</string>")
    expect(patched).toContain(`<key>CFBundleVersion</key>\n\t<string>${devBundleIdentityVersion}</string>`)
    expect(patched).toContain(`<key>CFBundleShortVersionString</key>\n\t<string>0.0.${devBundleIdentityVersion}</string>`)
  })

  test("adds missing display name metadata", () => {
    const patched = patchMacInfoPlist("<plist><dict><key>CFBundleName</key><string>Electron</string></dict></plist>", "easycode")

    expect(patched).toContain("<key>CFBundleDisplayName</key>")
    expect(patched).toContain("<string>easycode</string>")
  })

  test("adds missing macOS metadata to the top-level plist dictionary only", () => {
    const patched = patchMacInfoPlist([
      "<plist>",
      "<dict>",
      "<key>LSEnvironment</key>",
      "<dict>",
      "<key>MallocNanoZone</key>",
      "<string>0</string>",
      "</dict>",
      "</dict>",
      "</plist>",
    ].join("\n"), "easycode")

    expect(patched).toContain("<key>LSEnvironment</key>\n<dict>\n<key>MallocNanoZone</key>\n<string>0</string>\n</dict>")
    expect(patched).toContain("<key>CFBundleName</key>\n\t<string>easycode</string>\n\t<key>CFBundleIdentifier</key>")
    expect(patched).not.toContain("<key>LSEnvironment</key>\n<dict>\n<key>MallocNanoZone</key>\n<string>0</string>\n\t<key>")
  })

  test("renames localized macOS bundle display metadata", () => {
    const patched = patchMacLocalizedInfoPlistStrings([
      "\"CFBundleDisplayName\" = \"Electron\";",
      "\"CFBundleName\" = \"Electron\";",
    ].join("\n"), "easycode")

    expect(patched).toContain("\"CFBundleDisplayName\" = \"easycode\";")
    expect(patched).toContain("\"CFBundleName\" = \"easycode\";")
    expect(patched).not.toContain("\"Electron\"")
  })

  test("renames macOS helper bundle metadata", () => {
    const patched = patchMacHelperInfoPlist([
      "<plist>",
      "<dict>",
      "<key>CFBundleIdentifier</key>",
      "<string>com.github.Electron.helper</string>",
      "<key>CFBundleName</key>",
      "<string>Electron Helper (Renderer)</string>",
      "</dict>",
      "</plist>",
    ].join("\n"), "easycode")

    expect(patched).toContain("<key>CFBundleName</key>\n<string>easycode Helper (Renderer)</string>")
    expect(patched).toContain("<key>CFBundleDisplayName</key>\n\t<string>easycode Helper (Renderer)</string>")
    expect(patched).toContain(`<key>CFBundleIdentifier</key>\n<string>${devBundleIdentifier}.helper.renderer</string>`)
    expect(patched).not.toContain("Electron Helper")
    expect(patched).not.toContain("com.github.Electron")
  })

  test("renames already-patched helper metadata idempotently", () => {
    const once = patchMacHelperInfoPlist([
      "<plist>",
      "<dict>",
      "<key>CFBundleIdentifier</key>",
      "<string>com.github.Electron.helper</string>",
      "<key>CFBundleName</key>",
      "<string>Electron Helper</string>",
      "</dict>",
      "</plist>",
    ].join("\n"), "easycode")
    const twice = patchMacHelperInfoPlist(once, "easycode")

    expect(twice).toContain("<key>CFBundleName</key>\n<string>easycode Helper</string>")
    expect(twice).not.toContain("easycode Helpereasycode")
  })

  test("renames the copied macOS dev app display metadata while preserving Electron runtime executables", () => {
    const root = path.join(os.tmpdir(), `easycode-dev-launcher-${process.pid}-${Date.now()}`)
    tempRoots.push(root)
    const sourceApp = path.join(root, "Electron.app")
    const sourceMacos = path.join(sourceApp, "Contents", "MacOS")
    const sourceHelper = path.join(sourceApp, "Contents", "Frameworks", "Electron Helper.app", "Contents")
    const sourceResources = path.join(sourceApp, "Contents", "Resources", "en.lproj")
    const sourceHelperResources = path.join(sourceHelper, "Resources", "en.lproj")
    const targetRoot = path.join(root, "target")
    const legacyTargetApp = path.join(targetRoot, "easycode.app")
    mkdirSync(sourceMacos, { recursive: true })
    mkdirSync(sourceHelper, { recursive: true })
    mkdirSync(sourceResources, { recursive: true })
    mkdirSync(sourceHelperResources, { recursive: true })
    mkdirSync(legacyTargetApp, { recursive: true })
    writeFileSync(path.join(sourceMacos, "Electron"), "")
    writeFileSync(path.join(sourceResources, "InfoPlist.strings"), "\"CFBundleDisplayName\" = \"Electron\";\n\"CFBundleName\" = \"Electron\";\n")
    writeFileSync(path.join(sourceHelperResources, "InfoPlist.strings"), "\"CFBundleDisplayName\" = \"Electron Helper\";\n\"CFBundleName\" = \"Electron Helper\";\n")
    writeFileSync(path.join(sourceHelper, "Info.plist"), [
      "<plist>",
      "<dict>",
      "<key>CFBundleName</key>",
      "<string>Electron Helper</string>",
      "<key>CFBundleIdentifier</key>",
      "<string>com.github.Electron.helper</string>",
      "</dict>",
      "</plist>",
    ].join("\n"))
    writeFileSync(path.join(sourceApp, "Contents", "Info.plist"), [
      "<plist>",
      "<dict>",
      "<key>CFBundleName</key>",
      "<string>Electron</string>",
      "<key>CFBundleExecutable</key>",
      "<string>Electron</string>",
      "</dict>",
      "</plist>",
    ].join("\n"))

    const launcher = ensureMacDevApp(sourceApp, { name: "easycode", targetRoot })
    const plist = readFileSync(path.join(launcher.appPath, "Contents", "Info.plist"), "utf8")
    const helperPlist = readFileSync(path.join(launcher.appPath, "Contents", "Frameworks", "Electron Helper.app", "Contents", "Info.plist"), "utf8")
    const localizedStrings = readFileSync(path.join(launcher.appPath, "Contents", "Resources", "en.lproj", "InfoPlist.strings"), "utf8")
    const helperLocalizedStrings = readFileSync(path.join(launcher.appPath, "Contents", "Frameworks", "Electron Helper.app", "Contents", "Resources", "en.lproj", "InfoPlist.strings"), "utf8")

    expect(launcher.executablePath.endsWith(path.join("Contents", "MacOS", "Electron"))).toBe(true)
    expect(plist).toContain("<key>CFBundleExecutable</key>")
    expect(plist).toContain("<string>Electron</string>")
    expect(plist).toContain("<key>CFBundleIconFile</key>")
    expect(plist).toContain("<string>electron.icns</string>")
    expect(plist).toContain("<string>easycode</string>")
    expect(helperPlist).toContain("<string>Electron Helper</string>")
    expect(localizedStrings).toContain("\"CFBundleDisplayName\" = \"easycode\";")
    expect(localizedStrings).not.toContain("\"Electron\"")
    expect(helperLocalizedStrings).toContain("\"CFBundleDisplayName\" = \"Electron Helper\";")
    expect(readFileSync(path.join(targetRoot, "source.txt"), "utf8").split("\n")).toHaveLength(5)
    expect(() => readFileSync(path.join(legacyTargetApp, "Contents", "Info.plist"), "utf8")).toThrow()
  })

  test("rebuilds the copied macOS dev app when the identity version changes", () => {
    const root = path.join(os.tmpdir(), `easycode-dev-launcher-version-${process.pid}-${Date.now()}`)
    tempRoots.push(root)
    const sourceApp = path.join(root, "Electron.app")
    const sourceMacos = path.join(sourceApp, "Contents", "MacOS")
    mkdirSync(sourceMacos, { recursive: true })
    writeFileSync(path.join(sourceMacos, "Electron"), "")
    writeFileSync(path.join(sourceApp, "Contents", "Info.plist"), [
      "<plist>",
      "<dict>",
      "<key>CFBundleName</key>",
      "<string>Electron</string>",
      "<key>CFBundleExecutable</key>",
      "<string>Electron</string>",
      "</dict>",
      "</plist>",
    ].join("\n"))

    const targetRoot = path.join(root, "target")
    const first = ensureMacDevApp(sourceApp, { name: "easycode", targetRoot })
    writeFileSync(path.join(targetRoot, "source.txt"), `${sourceApp}\neasycode\nold-version\n`)
    writeFileSync(path.join(first.appPath, "Contents", "Info.plist"), "<plist><dict><key>CFBundleName</key><string>Electron</string></dict></plist>")

    const rebuilt = ensureMacDevApp(sourceApp, { name: "easycode", targetRoot })
    const rebuiltPlist = readFileSync(path.join(rebuilt.appPath, "Contents", "Info.plist"), "utf8")

    expect(rebuiltPlist).toContain(`<string>${devBundleIdentifier}</string>`)
    expect(rebuiltPlist).toContain("<key>CFBundleName</key>")
    expect(rebuiltPlist).toContain("<string>easycode</string>")
  })
})
