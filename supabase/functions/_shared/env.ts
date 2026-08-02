// Secret resolution.
//
// The exact secret names already set on the Supabase project could not be
// inspected while this was written, so each logical secret resolves through a
// short alias list. Whichever name is actually set gets picked up. This keeps a
// working deployment from hinging on guessing between STRIPE_SECRET_KEY and
// PPR_STRIPE_SECRET_KEY.

const ALIASES: Record<string, string[]> = {
  STRIPE_SECRET_KEY: [
    'STRIPE_SECRET_KEY',
    'PPR_STRIPE_SECRET_KEY',
    'STRIPE_API_KEY',
    'STRIPE_SK',
  ],
  STRIPE_WEBHOOK_SECRET: [
    'STRIPE_WEBHOOK_SECRET',
    'PPR_STRIPE_WEBHOOK_SECRET',
    'STRIPE_WEBHOOK_SIGNING_SECRET',
  ],
  RESEND_API_KEY: [
    'RESEND_API_KEY',
    'PPR_RESEND_API_KEY',
    'RESEND_KEY',
  ],
  NOTIFICATION_EMAILS: [
    'NOTIFICATION_EMAILS',
    'PPR_NOTIFICATION_EMAILS',
    'NOTIFY_EMAILS',
    'STAFF_EMAILS',
  ],
  RESEND_FROM: [
    'RESEND_FROM',
    'PPR_RESEND_FROM',
    'NOTIFICATION_FROM',
    'EMAIL_FROM',
  ],
  SITE_URL: [
    'SITE_URL',
    'PPR_SITE_URL',
    'PUBLIC_SITE_URL',
  ],
  ALLOWED_ORIGINS: [
    'ALLOWED_ORIGINS',
    'PPR_ALLOWED_ORIGINS',
    'CORS_ORIGINS',
  ],
  NOTIFICATION_PREFIX: [
    'NOTIFICATION_PREFIX',
    'PPR_NOTIFICATION_PREFIX',
  ],
  SUPABASE_URL: ['SUPABASE_URL'],
  SUPABASE_SERVICE_ROLE_KEY: [
    'SUPABASE_SERVICE_ROLE_KEY',
    'SERVICE_ROLE_KEY',
  ],
};

/** First non-empty value among the aliases for `name`, or `fallback`. */
export function env(name: string, fallback = ''): string {
  for (const key of ALIASES[name] ?? [name]) {
    const value = Deno.env.get(key);
    if (value && value.trim()) return value.trim();
  }
  return fallback;
}

export function hasEnv(name: string): boolean {
  return env(name) !== '';
}

/**
 * Presence-only report for `GET ?health=1`. Returns booleans, never values, so
 * it is safe to expose unauthenticated -- it confirms setup without leaking a
 * single character of any secret.
 */
export function healthReport(required: string[], optional: string[] = []) {
  const secrets: Record<string, boolean> = {};
  for (const name of [...required, ...optional]) secrets[name] = hasEnv(name);
  const missing = required.filter((name) => !hasEnv(name));
  return {
    ok: missing.length === 0,
    configured: missing.length === 0,
    missing,
    secrets,
  };
}
