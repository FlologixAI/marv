/** An amount in cents as text: formatPrice(1999, "EUR") is "19.99 EUR". */
export function formatPrice(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}
