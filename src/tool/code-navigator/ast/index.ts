import path from "node:path"
import * as ts from "typescript"
import type { CodeIndexSymbol } from "../types"
import { maskSearchableLines } from "../parsing"

export type LocalBindingScope = {
  ownerID: string
  startLine: number
  endLine: number
  names: Set<string>
  typeHints: Map<string, string>
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

export function extractTypeScriptMemberOwners(text: string, filePath: string) {
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKindFor(filePath))
  const owners = new Map<number, string>()

  const visit = (node: ts.Node) => {
    if (ts.isClassLike(node) || ts.isInterfaceDeclaration(node)) {
      const ownerName = node.name?.text
      if (ownerName) {
        for (const member of node.members) {
          const memberName = extractMemberName(member)
          if (!memberName) continue
          owners.set(lineFor(source, member.getStart(source)), ownerName)
        }
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return owners
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
      scopes.push({ ownerID: symbol.id, startLine: symbol.startLine, endLine: symbol.endLine, names, typeHints: new Map() })
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
        const typeHints = new Map<string, string>()
        const ownerTypeName = enclosingTypeName(node)
        if (ownerTypeName) typeHints.set("this", ownerTypeName)
        for (const param of node.parameters) {
          collectTypeScriptBindingNames(param.name, names)
          collectTypeScriptParameterTypeHints(param, typeHints, source)
        }
        collectTypeScriptBodyLocalBindings(node.body, names, typeHints, source)
        if (names.size > 0 || typeHints.size > 0) scopes.push({ ownerID: owner.id, startLine, endLine, names, typeHints })
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

function collectTypeScriptBodyLocalBindings(body: ts.ConciseBody, names: Set<string>, typeHints: Map<string, string>, source: ts.SourceFile) {
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isImportClause(node)) {
      const name = "name" in node ? node.name : undefined
      if (name) {
        collectTypeScriptBindingNames(name, names)
        if (ts.isVariableDeclaration(node)) collectTypeScriptVariableTypeHints(node, typeHints, source)
      }
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

function collectTypeScriptParameterTypeHints(param: ts.ParameterDeclaration, typeHints: Map<string, string>, source: ts.SourceFile) {
  if (!ts.isIdentifier(param.name)) return
  const hint = extractTypeHintFromTypeNode(param.type, source)
  if (hint) typeHints.set(param.name.text, hint)
}

function collectTypeScriptVariableTypeHints(node: ts.VariableDeclaration, typeHints: Map<string, string>, source: ts.SourceFile) {
  if (!ts.isIdentifier(node.name)) return
  const fromInitializer = extractTypeHintFromInitializer(node.initializer)
  if (fromInitializer) {
    typeHints.set(node.name.text, fromInitializer)
    return
  }
  const fromAnnotation = extractTypeHintFromTypeNode(node.type, source)
  if (fromAnnotation) typeHints.set(node.name.text, fromAnnotation)
}

function extractTypeHintFromInitializer(initializer: ts.Expression | undefined): string | undefined {
  if (!initializer || !ts.isNewExpression(initializer)) return undefined
  return extractTypeHintFromExpression(initializer.expression)
}

function extractTypeHintFromTypeNode(typeNode: ts.TypeNode | undefined, source: ts.SourceFile): string | undefined {
  if (!typeNode) return undefined
  if (ts.isTypeReferenceNode(typeNode)) return extractTypeHintFromTypeName(typeNode.typeName)
  if (ts.isExpressionWithTypeArguments(typeNode)) return extractTypeHintFromExpression(typeNode.expression)
  if (ts.isUnionTypeNode(typeNode) || ts.isIntersectionTypeNode(typeNode)) {
    for (const item of typeNode.types) {
      const hint = extractTypeHintFromTypeNode(item, source)
      if (hint) return hint
    }
    return undefined
  }
  if (ts.isParenthesizedTypeNode(typeNode)) return extractTypeHintFromTypeNode(typeNode.type, source)
  const text = typeNode.getText(source).trim()
  return /^[A-Za-z_$][\w$]*$/.test(text) ? text : undefined
}

function extractTypeHintFromTypeName(typeName: ts.EntityName): string {
  if (ts.isIdentifier(typeName)) return typeName.text
  return typeName.right.text
}

function extractTypeHintFromExpression(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  return undefined
}

function enclosingTypeName(node: ts.Node): string | undefined {
  let current = node.parent
  while (current) {
    if ((ts.isClassLike(current) || ts.isInterfaceDeclaration(current)) && current.name?.text) return current.name.text
    current = current.parent
  }
  return undefined
}

function extractMemberName(member: ts.ClassElement | ts.TypeElement): string | undefined {
  if (
    ts.isMethodDeclaration(member) ||
    ts.isMethodSignature(member) ||
    ts.isConstructorDeclaration(member) ||
    ts.isGetAccessorDeclaration(member) ||
    ts.isSetAccessorDeclaration(member)
  ) {
    if (ts.isConstructorDeclaration(member)) return "constructor"
    const name = member.name
    return name && ts.isIdentifier(name) ? name.text : undefined
  }
  return undefined
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
