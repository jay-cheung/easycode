import path from "node:path"
import { z } from "zod"
import type { Sandbox } from "./sandbox"

const ConnectorTool = z.object({
  name: z.string(),
  description: z.string(),
  command: z.string(),
})

const ConnectorConfig = z.object({
  tools: z.array(ConnectorTool).default([]),
})

export type ConnectorTool = z.infer<typeof ConnectorTool>

export class ConnectorService {
  readonly configPath: string

  constructor(root: string) {
    this.configPath = path.join(root, ".easycode", "connectors.json")
  }

  async list() {
    return (await this.load()).tools
  }

  async call(name: string, sandbox: Sandbox, signal?: AbortSignal) {
    const tool = (await this.list()).find((item) => item.name === name)
    if (!tool) throw new Error(`Connector not found: ${name}`)
    const result = await sandbox.execute({ command: tool.command }, "build", { signal })
    return { tool, result }
  }

  private async load() {
    const file = Bun.file(this.configPath)
    if (!(await file.exists())) return { tools: [] as ConnectorTool[] }
    return ConnectorConfig.parse(JSON.parse(await file.text()))
  }
}
