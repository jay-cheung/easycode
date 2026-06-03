import { expect, test } from "bun:test";
import { calculateArea } from "../src/index";

test("calculateArea computes correct area", () => {
  expect(calculateArea(5, 10)).toBe(50);
});
