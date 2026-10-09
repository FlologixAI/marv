/** An amount in cents as text: formatMoney(1999, "EUR") is "19.99 EUR". */
export function formatMoney(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}
