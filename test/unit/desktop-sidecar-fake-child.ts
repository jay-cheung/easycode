export class FakePipe {
  readonly writes: string[] = []
  private readonly dataHandlers: Array<(chunk: string) => void> = []

  on(event: string, handler: (chunk: string) => void) {
    if (event === "data") this.dataHandlers.push(handler)
    return this
  }

  write(chunk: string) {
    this.writes.push(chunk)
    return true
  }

  emitData(chunk: string) {
    for (const handler of this.dataHandlers) handler(chunk)
  }
}

export class FakeChild {
  readonly stdin = new FakePipe()
  readonly stdout = new FakePipe()
  readonly stderr = new FakePipe()
  killed = false
  exitCode: number | null = null
  signalCode: string | null = null
  private readonly handlers = new Map<string, Array<(value: any) => void>>()

  on(event: string, handler: (value: any) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
    return this
  }

  kill() {
    this.killed = true
    this.signalCode = "SIGTERM"
    return true
  }

  emit(event: string, value: any) {
    if (event === "exit") this.exitCode = value
    for (const handler of this.handlers.get(event) ?? []) handler(value)
  }
}
