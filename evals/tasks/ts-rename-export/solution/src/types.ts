import type { formatMoney } from "./format.ts";

/** Anything that turns cents into text the way formatMoney does. */
export type Formatter = typeof formatMoney;
