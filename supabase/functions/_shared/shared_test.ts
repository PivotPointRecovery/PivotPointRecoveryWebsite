// Tests for the shared validation and CORS logic -- the parts that decide what
// is chargeable and who is allowed to call us.
//
//   deno test --allow-env supabase/functions/_shared/shared_test.ts

import { assertEquals } from 'jsr:@std/assert@1';
import { amountToCents, email, escapeHtml, str, strList } from './validate.ts';
import { corsHeaders } from './http.ts';

Deno.test('str strips control characters but keeps newlines and tabs', () => {
  assertEquals(str('hello\x00\x07world'), 'helloworld');
  assertEquals(str('line one\nline two'), 'line one\nline two');
  assertEquals(str('  padded  '), 'padded');
  assertEquals(str(12345), '');
  assertEquals(str(null), '');
});

Deno.test('str caps length', () => {
  assertEquals(str('x'.repeat(500), 10).length, 10);
});

Deno.test('email accepts valid and rejects invalid', () => {
  assertEquals(email('Person@Example.COM'), 'person@example.com');
  assertEquals(email('not-an-email'), '');
  assertEquals(email('a@b'), '');
  assertEquals(email(''), '');
});

Deno.test('strList bounds items and entries', () => {
  assertEquals(strList(['a', 'b']), ['a', 'b']);
  assertEquals(strList('nope'), []);
  assertEquals(strList(Array(50).fill('x')).length, 25);
});

Deno.test('amountToCents converts dollars to integer cents', () => {
  assertEquals(amountToCents(50), 5000);
  assertEquals(amountToCents('25'), 2500);
  assertEquals(amountToCents(10.99), 1099);
  // Floating point: 0.1+0.2 style drift must not produce a fractional cent.
  assertEquals(amountToCents(35.35), 3535);
});

Deno.test('amountToCents rejects out-of-range and junk', () => {
  assertEquals(amountToCents(0), null);
  assertEquals(amountToCents(0.5), null); // below the $1 minimum
  assertEquals(amountToCents(-100), null); // negative
  assertEquals(amountToCents(50_001), null); // above the $50k ceiling
  assertEquals(amountToCents('abc'), null);
  assertEquals(amountToCents(Infinity), null);
  assertEquals(amountToCents(NaN), null);
  assertEquals(amountToCents(null), null);
});

Deno.test('escapeHtml neutralises injection into notification emails', () => {
  assertEquals(
    escapeHtml('<script>alert("x")</script>'),
    '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
  );
});

function originHeader(origin: string): string | undefined {
  const req = new Request('https://example.test', { headers: { origin } });
  return corsHeaders(req)['Access-Control-Allow-Origin'];
}

Deno.test('CORS allows production origins', () => {
  assertEquals(originHeader('https://pivotpointrecovery.org'), 'https://pivotpointrecovery.org');
  assertEquals(
    originHeader('https://www.pivotpointrecovery.org'),
    'https://www.pivotpointrecovery.org',
  );
});

Deno.test('CORS allows Pages previews and localhost', () => {
  assertEquals(originHeader('https://abc123.pages.dev'), 'https://abc123.pages.dev');
  assertEquals(originHeader('http://localhost:8080'), 'http://localhost:8080');
});

Deno.test('CORS refuses unknown origins', () => {
  // The header is absent entirely, so the browser blocks the response.
  assertEquals(originHeader('https://evil.example.com'), undefined);
  assertEquals(originHeader('https://pivotpointrecovery.org.evil.com'), undefined);
  assertEquals(originHeader('http://pivotpointrecovery.org'), undefined); // not https
  assertEquals(originHeader(''), undefined);
  assertEquals(originHeader('garbage'), undefined);
});
