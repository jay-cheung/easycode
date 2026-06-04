import { ToolRegistry } from "./registry"
import { registerCodeTools } from "./builtins/code-tools"
import { registerGitTools } from "./builtins/git-tools"
import { registerRetrievalTools } from "./builtins/retrieval-tools"
import { registerWorkspaceTools } from "./builtins/workspace-tools"

export function createBuiltinRegistry() {
  const registry = new ToolRegistry()

  registerCodeTools(registry)
  registerGitTools(registry)
  registerWorkspaceTools(registry)
  registerRetrievalTools(registry)

  return registry
}
