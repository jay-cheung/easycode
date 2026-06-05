export type CodeSearchResult = {
  filePath: string
  line: number
  preview: string
}

export type CodeRange = {
  filePath: string
  startLine: number
  endLine: number
}

export type RepoMapSymbol = {
  name: string
  kind: string
  line: number
  signature?: string
}

export type RepoMapEntry = {
  filePath: string
  hash: string
  mtimeMs: number
  size: number
  imports?: string[]
  exports?: string[]
  symbols: RepoMapSymbol[]
}

export type RepoMapResult = {
  root: string
  dir: string
  generatedAt: string
  generatorVersion: string
  toolVersions: Record<string, string>
  entries: RepoMapEntry[]
  cache: {
    path: string
    hit: boolean
    gitIgnored: boolean
    rebuiltFiles?: number
  }
}

export type CodeIndexFile = {
  filePath: string
  hash: string
  mtimeMs: number
  size: number
  imports: string[]
  exports: string[]
  importBindings?: Array<{ local: string; imported: string; source: string }>
  exportBindings?: Array<{ exported: string; local: string; source?: string }>
}

export type CodeIndexSymbol = {
  id: string
  qualifiedName: string
  filePath: string
  name: string
  kind: string
  startLine: number
  endLine: number
  signature?: string
  exported?: boolean
  exportStyle?: "named" | "default"
  ownerID?: string
}

export type CodeIndexEdgeKind = "imports" | "exports" | "calls" | "references" | "inherits" | "implements"

export type CodeIndexEdge = {
  kind: CodeIndexEdgeKind
  from: string
  to: string
  fromName?: string
  toID?: string
  toName?: string
  receiverName?: string
  resolved?: boolean
  filePath: string
  line: number
  preview?: string
}

export type CallGraphDirection = "callers" | "callees" | "both"

export type CallGraphResult = {
  symbol: string
  direction: CallGraphDirection
  depth: number
  nodes: Array<{ id: string; name: string; filePath: string; line: number; signature?: string }>
  edges: Array<{ from: string; to: string; filePath: string; line: number; preview?: string }>
}

export type CodeIndexResult = {
  root: string
  dir: string
  generatedAt: string
  generatorVersion: string
  toolVersions: Record<string, string>
  files: CodeIndexFile[]
  symbols: CodeIndexSymbol[]
  edges: CodeIndexEdge[]
  cache: {
    path: string
    hit: boolean
    gitIgnored: boolean
    rebuiltFiles?: number
  }
}

export interface CodeNavigator {
  rgSearch(input: { query: string; dir?: string; fileType?: string; maxResults?: number }): Promise<CodeSearchResult[]>
  readLines(input: { filePath: string; startLine: number; endLine: number }): Promise<CodeRange & { content: string }>
  findDefinition(input: { symbol: string; language?: string; maxResults?: number }): Promise<CodeSearchResult[]>
  findReferences(input: { symbol: string; language?: string; maxResults?: number }): Promise<CodeSearchResult[]>
  callGraph(input: { symbol: string; direction?: CallGraphDirection; depth?: number; language?: string; maxResults?: number }): Promise<CallGraphResult>
  repoMap(input: { dir?: string; language?: string; maxFiles?: number; useCache?: boolean; query?: string }): Promise<RepoMapResult>
}

export type CommandResult = {
  exitCode: number | null
  stdout: string
  stderr: string
}

export type CommandRunner = (command: string, args: string[], options: { cwd: string; signal?: AbortSignal }) => Promise<CommandResult>
