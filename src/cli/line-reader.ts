import { createInterface } from "node:readline"
import type { Interface } from "node:readline"
import { stdout as output } from "node:process"

export const eofPrompt = "\0__easycode_eof__"

export type LinePriority = "foreground" | "background"

type LineWaiter = {
  resolve: (line: string) => void
  signal?: AbortSignal
  onAbort?: () => void
}

export class LineReader {
  private pending: string[] = []
  private readonly foreground: LineWaiter[] = []
  private readonly background: LineWaiter[] = []

  constructor(private readonly rl: Interface = createInterface({ input: process.stdin, output })) {
    this.rl.on("line", (line) => this.receive(line))
    this.rl.on("close", () => this.closeWaiters())
  }

  question(prompt: string, priority: LinePriority = "foreground", signal?: AbortSignal) {
    output.write(prompt)
    return this.nextLine(priority, signal)
  }

  nextLine(priority: LinePriority = "foreground", signal?: AbortSignal) {
    if (signal?.aborted) return Promise.resolve(eofPrompt)
    const queued = this.pending.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    return new Promise<string>((resolve) => {
      const waiter: LineWaiter = { resolve, signal }
      waiter.onAbort = () => {
        this.removeWaiter(waiter)
        resolve(eofPrompt)
      }
      signal?.addEventListener("abort", waiter.onAbort, { once: true })
      ;(priority === "foreground" ? this.foreground : this.background).push(waiter)
    })
  }

  close() {
    this.rl.close()
  }

  private receive(line: string) {
    const waiter = this.foreground.shift() ?? this.background.shift()
    if (!waiter) {
      this.pending.push(line)
      return
    }
    if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort)
    waiter.resolve(line)
  }

  private removeWaiter(waiter: LineWaiter) {
    removeItem(this.foreground, waiter)
    removeItem(this.background, waiter)
  }

  private closeWaiters() {
    for (const waiter of [...this.foreground.splice(0), ...this.background.splice(0)]) {
      if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort)
      waiter.resolve(eofPrompt)
    }
  }
}

function removeItem<T>(items: T[], item: T) {
  const index = items.indexOf(item)
  if (index !== -1) items.splice(index, 1)
}
