// CORS + response helpers.
//
// The previously deployed function answered `access-control-allow-origin: *`,
// which let any site on the internet post to it. These functions use an
// explicit allowlist instead and echo back only a matching origin.

import { env } from './env.ts';

const DEFAULT_ORIGINS = [
  'https://pivotpointrecovery.org',
  'https://www.pivotpointrecovery.org',
];

/** Allowlist from ALLOWED_ORIGINS, falling back to the production hosts. */
function allowlist(): string[] {
  const configured = env('ALLOWED_ORIGINS');
  if (!configured) return DEFAULT_ORIGINS;
  return configured.split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
}

function isAllowed(origin: string): boolean {
  if (!origin) return false;
  const normalized = origin.replace(/\/$/, '');
  if (allowlist().includes(normalized)) return true;

  // Cloudflare Pages preview deploys (*.pages.dev) and local dev servers. Both
  // are non-production surfaces we still want to be able to exercise the forms.
  try {
    const { hostname, protocol } = new URL(normalized);
    if (protocol === 'https:' && hostname.endsWith('.pages.dev')) return true;
    if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
  } catch {
    return false;
  }
  return false;
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (isAllowed(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

export function preflight(req: Request): Response | null {
  if (req.method !== 'OPTIONS') return null;
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
  });
}

/** Client-visible failure. Message is safe to show a donor or visitor. */
export function fail(req: Request, message: string, status = 400): Response {
  return json(req, { ok: false, error: message }, status);
}
