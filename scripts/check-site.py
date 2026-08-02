#!/usr/bin/env python3
"""Static checks for the site: internal links resolve, local assets exist,
HTML tags balance, and the sitemap matches the pages on disk.

There is no build step and no templating, so shared markup (nav, footer, meta)
is duplicated across pages by design. That makes it easy to add a page and
forget a link, or rename a file and orphan a reference. This catches both.

    python3 scripts/check-site.py

Exits non-zero on any problem, so CI can gate on it.
"""
import pathlib
import re
import sys
from html.parser import HTMLParser

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE = 'https://pivotpointrecovery.org'

# Intentionally excluded from the sitemap; both carry <meta name="robots"
# content="noindex">.
NOINDEX = {'404.html', 'thank-you.html'}

VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
        'meta', 'param', 'source', 'track', 'wbr'}

EXTERNAL = ('http://', 'https://', 'mailto:', 'tel:', 'sms:', '#', 'data:')


def resolves(target: str) -> bool:
    """Does a link resolve, the way Cloudflare Pages serves clean URLs?"""
    t = target.split('#')[0].split('?')[0]
    if t in ('', '/'):
        return (ROOT / 'index.html').exists()
    t = t.lstrip('/')
    return any((ROOT / candidate).exists() for candidate in (t, t + '.html'))


class Balance(HTMLParser):
    """Flags unclosed and mismatched tags."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.errors = []

    def handle_starttag(self, tag, attrs):
        if tag not in VOID:
            self.stack.append((tag, self.getpos()[0]))

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        if not self.stack:
            self.errors.append(f'stray </{tag}> at line {self.getpos()[0]}')
        elif self.stack[-1][0] != tag:
            open_tag, line = self.stack[-1]
            self.errors.append(
                f'</{tag}> at line {self.getpos()[0]} closes '
                f'<{open_tag}> opened at line {line}')
            self.stack.pop()
        else:
            self.stack.pop()


def main() -> int:
    pages = sorted(ROOT.glob('*.html'))
    problems = []

    for page in pages:
        raw = page.read_text()
        name = page.name
        # Commented-out markup and documentation examples are not live
        # references, so strip comments before scanning links and assets.
        html = re.sub(r'<!--.*?-->', '', raw, flags=re.S)

        balance = Balance()
        balance.feed(raw)
        problems += [f'{name}: {e}' for e in balance.errors]
        problems += [f'{name}: <{tag}> opened line {line} never closed'
                     for tag, line in balance.stack]

        for href in re.findall(r'href="([^"]+)"', html):
            if not href.startswith(EXTERNAL) and not resolves(href):
                problems.append(f'{name}: dead link href="{href}"')

        for src in re.findall(r'src="([^"]+)"', html):
            if src.startswith(('http://', 'https://', 'data:')):
                continue
            if not (ROOT / src.lstrip('/')).exists():
                problems.append(f'{name}: missing asset src="{src}"')

        for needle, label in [('<title>', 'title'),
                              ('name="viewport"', 'viewport'),
                              ('name="description"', 'description')]:
            if needle not in raw:
                problems.append(f'{name}: missing {label}')

        # The portal is a separate application; the site must not call it.
        if re.search(r'["\'](/api/)', html):
            problems.append(f'{name}: same-origin /api call -- the site must '
                            f'not depend on the portal')

    sitemap = (ROOT / 'sitemap.xml').read_text()
    for loc in re.findall(rf'<loc>{re.escape(SITE)}([^<]*)</loc>', sitemap):
        if not resolves(loc):
            problems.append(f'sitemap.xml: {loc} does not resolve')

    for page in pages:
        if page.name in NOINDEX:
            continue
        slug = '/' if page.name == 'index.html' else '/' + page.stem
        if f'<loc>{SITE}{slug}</loc>' not in sitemap:
            problems.append(f'sitemap.xml: missing entry for {slug}')

    print(f'checked {len(pages)} pages')
    if problems:
        print(f'\n{len(problems)} problem(s):')
        for p in problems:
            print('  -', p)
        return 1
    print('all checks passed')
    return 0


if __name__ == '__main__':
    sys.exit(main())
