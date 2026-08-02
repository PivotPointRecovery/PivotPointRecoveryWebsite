// Input validation and normalisation.
//
// Everything a browser sends is untrusted. These helpers bound length, strip
// control characters, and escape anything destined for an HTML email body.

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Control characters, keeping \t (\x09) and \n (\x0A) which are legitimate in a
// free-text message body.
// deno-lint-ignore no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/** Trim, drop control characters, and cap length. Non-strings become ''. */
export function str(value: unknown, maxLength = 2000): string {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_CHARS, '').trim().slice(0, maxLength);
}

export function email(value: unknown): string {
  const candidate = str(value, 254).toLowerCase();
  return EMAIL_RE.test(candidate) ? candidate : '';
}

export function bool(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

export function strList(value: unknown, maxItems = 25, maxLength = 200): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => str(v, maxLength)).filter(Boolean).slice(0, maxItems);
}

/**
 * Donation amount in dollars -> integer cents.
 *
 * The client sends an amount; the server decides what is chargeable. Rejects
 * anything non-finite, below $1, or above $50,000 -- an upper bound catches
 * both fat-finger entry and anyone probing the endpoint.
 */
export const MIN_DONATION_CENTS = 100;
export const MAX_DONATION_CENTS = 5_000_000;

export function amountToCents(value: unknown): number | null {
  const dollars = typeof value === 'number' ? value : Number(str(value, 20));
  if (!Number.isFinite(dollars)) return null;
  const cents = Math.round(dollars * 100);
  if (cents < MIN_DONATION_CENTS || cents > MAX_DONATION_CENTS) return null;
  return cents;
}

/** Escape for interpolation into an HTML email body. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
