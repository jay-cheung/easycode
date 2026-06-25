import { useEffect, useRef } from "react"

/**
 * Returns a ref whose `.current` value is kept in sync with the given value.
 * Eliminates the repetitive `useEffect(() => { ref.current = value }, [value])` pattern.
 */
export function useLatestRef<T>(value: T): { readonly current: T } {
  const ref = useRef(value)
  useEffect(() => {
    ref.current = value
  }, [value])
  return ref
}
