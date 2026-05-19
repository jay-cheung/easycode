export function score(items: number[]) {
  let total = 0
  for (const item of items) total += item
  return total
}
Oracle: time O(n), space O(1).