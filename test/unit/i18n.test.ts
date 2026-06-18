import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import ts from "typescript"

const i18nRoot = path.join(import.meta.dir, "..", "..", "src", "i18n")

function uiCopyKeys() {
  const sourceText = fs.readFileSync(path.join(i18nRoot, "types.ts"), "utf8")
  const source = ts.createSourceFile("types.ts", sourceText, ts.ScriptTarget.Latest, true)
  const keys: string[] = []

  function visit(node: ts.Node) {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === "UiCopy" && ts.isTypeLiteralNode(node.type)) {
      for (const member of node.type.members) {
        if ((ts.isPropertySignature(member) || ts.isMethodSignature(member)) && member.name) {
          keys.push(member.name.getText(source))
        }
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return keys
}

function explicitLanguageKeys(language: string) {
  const sourceText = fs.readFileSync(path.join(i18nRoot, `${language}.ts`), "utf8")
  const source = ts.createSourceFile(`${language}.ts`, sourceText, ts.ScriptTarget.Latest, true)
  const keys = new Set<string>()

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "cloneWith") {
      const overrides = node.arguments[1]
      if (overrides && ts.isObjectLiteralExpression(overrides)) {
        for (const property of overrides.properties) {
          if ((ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property) || ts.isMethodDeclaration(property)) && property.name) {
            keys.add(property.name.getText(source))
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return keys
}

describe("i18n copy", () => {
  test("non-English languages explicitly cover every UI copy field", () => {
    const expectedKeys = uiCopyKeys()

    for (const language of ["zh", "ja", "fr", "ko", "de"]) {
      const actualKeys = explicitLanguageKeys(language)
      const missing = expectedKeys.filter((key) => !actualKeys.has(key))
      expect(missing, `${language} is missing explicit translations`).toEqual([])
    }
  })
})
