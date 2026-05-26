import path from "node:path"
import { mkdirSync, readdirSync, unlinkSync } from "node:fs"

const MAX_PLANS_PER_SESSION = 20

export function planStoreDir(root: string, sessionId: string): string {
  return path.join(root, ".easycode", "plans", safePlanSegment(sessionId))
}

export function safePlanSegment(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]/g, "_")
}

function cleanupOldPlans(dir: string): void {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({ name: f, time: parseInt(f.replace(".md", ""), 10) }))
      .sort((a, b) => b.time - a.time)
    if (files.length > MAX_PLANS_PER_SESSION) {
      for (const file of files.slice(MAX_PLANS_PER_SESSION)) {
        unlinkSync(path.join(dir, file.name))
      }
    }
  } catch {
    /* cleanup failure should not block the user */
  }
}

export function stripPlanTags(text: string): string {
  return text.replace(/<\/?proposed_plan>/gi, "").trim()
}

export async function savePlan(root: string, sessionId: string, planMarkdown: string): Promise<string | undefined> {
  if (!planMarkdown) return
  const dir = planStoreDir(root, sessionId)
  mkdirSync(dir, { recursive: true })
  const timestamp = Date.now()
  const filePath = path.join(dir, `${timestamp}.md`)
  await Bun.write(filePath, stripPlanTags(planMarkdown))
  cleanupOldPlans(dir)
  return filePath
}
