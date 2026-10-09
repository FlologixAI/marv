import type { formatPrice } from "./format.ts";

/** Anything that turns cents into text the way formatPrice does. */
export type Formatter = typeof formatPrice;
