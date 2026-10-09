import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import * as format from "./src/format.ts";
import * as index from "./src/index.ts";
import { cartTotal } from "./src/cart.ts";
import { report } from "./src/report.ts";

test("formatPrice is now formatMoney", () => {
  expect(format.formatMoney(1999, "EUR")).toBe("19.99 EUR");
  expect(format.formatPrice).toBeUndefined();
  expect(index.formatMoney).toBe(format.formatMoney);
  expect(index.formatPrice).toBeUndefined();
});
test("its users still work", () => {
  expect(cartTotal([{ name: "tea", cents: 250, qty: 2 }])).toBe("5.00 EUR");
  expect(report([{ name: "tea", cents: 300, qty: 1 }])).toEqual(["tea: 3.00 EUR"]);
  expect(report([{ name: "tea", cents: 349, qty: 1 }], "short")).toEqual(["tea: 3 EUR"]);
});
test("no formatPrice is left in src/", () => {
  for (const file of readdirSync("src")) expect(readFileSync(`src/${file}`, "utf8")).not.toContain("formatPrice");
});
test("it typechecks", () => {
  const tsc = Bun.spawnSync(["node_modules/.bin/tsc", "--noEmit", "--pretty", "false", "-p", "tsconfig.json"]);
  expect(tsc.stdout.toString()).toBe("");
  expect(tsc.exitCode).toBe(0);
});
