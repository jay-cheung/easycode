import path from "node:path"

export function workspacePathInfo(workspaceRoot: string, filePath: string) {
  const resolvedRoot = path.resolve(workspaceRoot)
  const resolvedPath = path.resolve(filePath)
  const relativePath = path.relative(resolvedRoot, resolvedPath)
  const insideWorkspace = Boolean(relativePath) && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)
  return {
    insideWorkspace,
    ...(insideWorkspace ? { relativePath } : {}),
  }
}
