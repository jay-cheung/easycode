import { add, multiply } from "./utils";

// Calculate the total area of a bounding box
export function calculateArea(width: number, height: number): number {
  // BUG: Using add instead of multiply
  // Note: Check utils.ts for warnings on multiply() return types before fixing.
  return add(width, height);
}
