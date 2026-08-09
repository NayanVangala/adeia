/**
 * Display-only. Nothing in the money *path* ever leaves integer cents — this
 * exists so an approval email can say "$500.00" instead of "50000".
 *
 * Assumes a two-decimal currency. Zero-decimal currencies (JPY, KRW) would
 * render 100× too small, which is the same limitation `amountCents` already
 * carries and is documented as out of scope for the MVP.
 */
export function formatMoney(amountCents: number, currency: string): string {
  const code = currency.toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(
      amountCents / 100,
    );
  } catch {
    // Unknown or malformed currency code — degrade rather than throw inside a
    // notification path.
    return `${(amountCents / 100).toFixed(2)} ${code}`;
  }
}
