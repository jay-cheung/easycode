type IpcHandler = (...args: any[]) => unknown

export function withIpcErrorBoundary<T extends IpcHandler>(handler: T): T {
  return (async (...args: Parameters<T>) => {
    try {
      return await handler(...args)
    } catch (error) {
      throw normalizeIpcError(error)
    }
  }) as T
}

export function normalizeIpcError(error: unknown) {
  if (error instanceof Error) return error
  if (typeof error === "string" && error.trim()) return new Error(error)
  return new Error("Desktop IPC request failed.")
}
