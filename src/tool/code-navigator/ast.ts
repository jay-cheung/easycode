import path from "node:path"
import * as ts from "typescript"
import type { CodeIndexSymbol } from "./types"
import { maskSearchableLines } from "./parsing"

export type LocalBindingScope = {
  ownerID: string
  startLine: number
  endLine: number
  names: Set<string>
}

const functionLikeKinds = new Set(["function", "method", "def", "func", "fn", "fun", "constructor"])
const genericKeywordBindings = new Set([
  "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "def", "defer", "else", "enum", "false", "finally", "for",
  "from", "func", "function", "if", "import", "in", "interface", "let", "new", "nil", "none", "null", "package", "pub", "return", "self",
  "static", "struct", "switch", "this", "true", "type", "undefined", "use", "var", "while",
])

export function extractLocalBindingScopes(text: string, filePath: string, symbols: CodeIndexSymbol[]): LocalBindingScope[] {
  if (isTypeScriptLike(path.extname(filePath))) return extractTypeScriptLocalBindingScopes(text, filePath, symbols)
  return extractGenericLocalBindingScopes(text, filePath, symbols)
}

export function isTypeScriptLike(extension: string) {
  return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(extension)
}

function extractGenericLocalBindingScopes(text: string, filePath: string, symbols: CodeIndexSymbol[]): LocalBindingScope[] {
  const lines = text.split(/\r?\n/)
  const searchableLines = maskSearchableLines(text)
  const extension = path.extname(filePath)
  const scopes: LocalBindingScope[] = []
  for (const symbol of symbols) {
    if (!functionLikeKinds.has(symbol.kind)) continue
    const names = new Set<string>()
    collectSignatureBindings(lines[symbol.startLine - 1] ?? "", extension, names)
    for (let lineIndex = symbol.startLine; lineIndex < Math.min(symbol.endLine, lines.length); lineIndex++) {
      collectLocalBindingsFromLine(searchableLines[lineIndex] ?? "", names)
    }
    if (names.size > 0) {
      scopes.push({ ownerID: symbol.id, startLine: symbol.startLine, endLine: symbol.endLine, names })
    }
  }
  return scopes
}

function collectSignatureBindings(line: string, extension: string, names: Set<string>) {
  const open = line.indexOf("(")
  if (open === -1) return
  const close = line.indexOf(")", open + 1)
  if (close === -1) return
  const parameters = line.slice(open + 1, close).split(",")
  for (const rawParameter of parameters) {
    const parameter = rawParameter.trim().replace(/^\*+/, "")
    if (!parameter) continue
    if (parameter.includes(":")) {
      collectBindingName(parameter.split(":")[0] ?? "", names)
      continue
    }
    if (parameter.includes("=")) {
      collectBindingName(parameter.split("=")[0] ?? "", names)
      continue
    }
    const identifiers = identifiersIn(parameter)
    if (identifiers.length === 1) {
      collectBindingName(identifiers[0] ?? "", names)
    } else if (identifiers.length > 1) {
      collectBindingName(extension === ".go" ? identifiers[0] ?? "" : identifiers.at(-1) ?? "", names)
    }
  }
}

function collectLocalBindingsFromLine(line: string, names: Set<string>) {
  for (const pattern of [
    /\b(?:const|let|var|val|final)\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:def|func|fn|function)\s+([A-Za-z_$][\w$]*)\s*\(/g,
    /\b(?:class|struct|enum|interface|type)\s+([A-Za-z_$][\w$]*)/g,
    /\b([A-Za-z_$][\w$]*)\s*:=/g,
    /\bfor\s+(?:.*?,\s*)?([A-Za-z_$][\w$]*)\s+(?:in|:=|=)/g,
    /\bwith\b.*?\bas\s+([A-Za-z_$][\w$]*)/g,
    /\bexcept\b.*?\bas\s+([A-Za-z_$][\w$]*)/g,
  ]) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(line)) !== null) collectBindingName(match[1] ?? "", names)
  }

  const assignment = line.match(/^\s*([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/)
  if (assignment?.[1] && !line.includes("==") && !line.includes("=>")) collectBindingName(assignment[1], names)

  if (!/^\s*return\b/.test(line)) {
    const typedDeclaration = line.match(/^\s*(?:[A-Za-z_$][\w$:<>,.[\]?*&]*\s+)+([A-Za-z_$][\w$]*)\s*(?:=|;)/)
    if (typedDeclaration?.[1]) collectBindingName(typedDeclaration[1], names)
  }
}

function collectBindingName(name: string, names: Set<string>) {
  if (!name || genericKeywordBindings.has(name.toLowerCase())) return
  names.add(name)
}

function identifiersIn(value: string) {
  return [...value.matchAll(/[A-Za-z_$][\w$]*/g)].map((match) => match[0]).filter((name) => !genericKeywordBindings.has(name.toLowerCase()))
}

function extractTypeScriptLocalBindingScopes(text: string, filePath: string, symbols: CodeIndexSymbol[]): LocalBindingScope[] {
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKindFor(filePath))
  const scopes: LocalBindingScope[] = []

  const visit = (node: ts.Node) => {
    if (isFunctionLikeWithBody(node)) {
      const startLine = lineFor(source, node.getStart(source))
      const endLine = lineFor(source, node.end)
      const owner = symbols.find((symbol) => symbol.startLine <= startLine && startLine <= symbol.endLine)
      if (owner) {
        const names = new Set<string>()
        for (const param of node.parameters) collectTypeScriptBindingNames(param.name, names)
        collectTypeScriptBodyLocalBindings(node.body, names)
        if (names.size > 0) scopes.push({ ownerID: owner.id, startLine, endLine, names })
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return scopes
}

function isFunctionLikeWithBody(node: ts.Node): node is ts.FunctionLikeDeclaration & { body: ts.ConciseBody } {
  return (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isConstructorDeclaration(node)) && Boolean(node.body)
}

function collectTypeScriptBodyLocalBindings(body: ts.ConciseBody, names: Set<string>) {
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isImportClause(node)) {
      const name = "name" in node ? node.name : undefined
      if (name) collectTypeScriptBindingNames(name, names)
    }
    if (ts.isFunctionLike(node) && node !== body) return
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(body, visit)
}

function collectTypeScriptBindingNames(name: ts.BindingName | ts.Identifier | undefined, names: Set<string>) {
  if (!name) return
  if (ts.isIdentifier(name)) {
    names.add(name.text)
    return
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) collectTypeScriptBindingNames(element.name, names)
  }
}

function lineFor(source: ts.SourceFile, position: number) {
  return source.getLineAndCharacterOfPosition(position).line + 1
}

function scriptKindFor(filePath: string) {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}
