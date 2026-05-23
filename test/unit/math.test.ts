import { describe, expect, test } from "bun:test"
import { clampInt, clampNumber } from "../../src/utils/math"

describe("math utils", () => {
  test("clampInt rounds finite values within bounds", () => {
    expect(clampInt(4.4, 1, 10)).toBe(4)
    expect(clampInt(4.5, 1, 10)).toBe(5)
    expect(clampInt(-1, 1, 10)).toBe(1)
    expect(clampInt(11, 1, 10)).toBe(10)
  })

  test("clampInt falls back to min for non-finite values", () => {
    expect(clampInt(Number.NaN, 1, 10)).toBe(1)
    expect(clampInt(Number.POSITIVE_INFINITY, 1, 10)).toBe(1)
    expect(clampInt(Number.NEGATIVE_INFINITY, 1, 10)).toBe(1)
  })

  test("clampNumber preserves finite precision and clamps bounds", () => {
    expect(clampNumber(4.5, 1, 10)).toBe(4.5)
    expect(clampNumber(-1, 1, 10)).toBe(1)
    expect(clampNumber(11, 1, 10)).toBe(10)
    expect(clampNumber(Number.NaN, 1, 10)).toBe(1)
  })
})
