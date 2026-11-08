import test from 'node:test';
import assert from 'node:assert/strict';
import { crawlSite, htmlToText, sameSite } from '../../relay/crawl.js';

const MENU = '<nav><a href="/">Home</a> <a href="/about">About</a></nav><div class="menu">Shop Blog Contact</div>';
const page = (title, body, extra = '') => ({ type: 'text/html; charset=utf-8', body: `<html><head><title>${title}</title><script>var x = 1;</script><style>p{}</style></head><body>${MENU}${extra}${body}<footer>© Site footer</footer></body></html>` });

// A fake web: answers by address, records what was fetched.
function fakeWeb(site) {
  const fetched = [];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    fetched.push(u);
    assert.equal(init?.headers?.['user-agent'], 'GenericDocumentAgent/1.0');
    const hit = site[u];
    if (!hit) return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
    return new Response(hit.body, { status: hit.status || 200, headers: { 'content-type': hit.type || 'text/html' } });
  };
  return { fetched, fetchImpl };
}

const SITE = {
  'https://site.test/': page('Home', '<h1>Welcome</h1><p>We sell kettles.</p><a href="/about">About us</a> <a href="https://other.com/x">Elsewhere</a> <a href="/manual.pdf">Manual</a> <a href="/about#team">Team</a> <a href="mailto:a@b.c">Mail</a> <a href="/private/secret">Secret</a> <a href="/logo.png">Logo</a>'),
  'https://site.test/about': page('About', '<h2>Our story</h2><ul><li>Founded 1990</li><li>In Wales</li></ul><a href="../team/">Team</a><p hidden>Hidden text</p>'),
  'https://site.test/team/': page('Team', '<p>Ana and Bea.</p><a href="https://www.site.test/about/">About again</a>'),
  'https://site.test/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /private\n' },
  'https://site.test/sitemap.xml': { type: 'application/xml', body: '<sitemapindex><sitemap><loc>https://site.test/sitemap-pages.xml</loc></sitemap></sitemapindex>' },
  'https://site.test/sitemap-pages.xml': { type: 'application/xml', body: '<urlset><url><loc>https://site.test/hidden-page</loc></url></urlset>' },
  'https://site.test/hidden-page': page('Hidden page', '<p>Only the sitemap knows me.</p>'),
  'https://site.test/logo.png': { type: 'image/png', body: 'PNG' },
};

test('htmlToText keeps content, drops scripts, menus and hidden parts, and resolves links', () => {
  const { title, text, links } = htmlToText(SITE['https://site.test/about'].body, 'https://site.test/about');
  assert.equal(title, 'About');
  assert.match(text, /Our story\nFounded 1990\nIn Wales/);
  for (const gone of ['var x', 'p{}', 'Site footer', 'Hidden text', 'Home About']) assert.ok(!text.includes(gone), gone);
  assert.ok(links.includes('https://site.test/team/'));
  const based = htmlToText('<html><head><base href="https://site.test/docs/"></head><body><a href="intro">x</a></body></html>', 'https://site.test/');
  assert.deepEqual(based.links, ['https://site.test/docs/intro']);
});

test('sameSite ignores www and the scheme', () => {
  assert.ok(sameSite(new URL('http://www.site.test/a'), new URL('https://site.test/')));
  assert.ok(!sameSite(new URL('https://other.com/'), new URL('https://site.test/')));
});

test('crawls the same site, with its sitemap, respecting robots.txt, each page once', async () => {
  const web = fakeWeb(SITE);
  const out = await crawlSite('https://site.test/', { fetchImpl: web.fetchImpl });
  assert.equal(out.host, 'site.test');
  assert.equal(out.pages, 4);
  assert.ok(out.text.startsWith('## Home\n(https://site.test/)\n\nWelcome\nWe sell kettles.'));
  for (const t of ['## About\n(https://site.test/about)', '## Team\n(https://site.test/team/)', 'Only the sitemap knows me.']) assert.ok(out.text.includes(t), t);
  for (const never of ['https://other.com/x', 'https://site.test/private/secret', 'https://site.test/manual.pdf']) assert.ok(!web.fetched.includes(never), never);
  const pages = web.fetched.filter((u) => !/robots|sitemap/.test(u));
  assert.equal(new Set(pages).size, pages.length, 'each page fetched once');
  assert.ok(!out.text.includes('Shop Blog Contact'), 'menu repeated on every page is dropped');
});

test('page limit and early stop', async () => {
  let out = await crawlSite('https://site.test/', { fetchImpl: fakeWeb(SITE).fetchImpl, maxPages: 2 });
  assert.equal(out.pages, 2);
  let calls = 0;
  out = await crawlSite('https://site.test/', { fetchImpl: fakeWeb(SITE).fetchImpl, tooBig: async () => ++calls >= 2 });
  assert.equal(out.pages, 2);
});

test('errors', async () => {
  await assert.rejects(crawlSite('ftp://site.test/'), /bad address/);
  await assert.rejects(crawlSite('not a url'), /bad address/);
  await assert.rejects(crawlSite('https://site.test/nope', { fetchImpl: fakeWeb(SITE).fetchImpl }), /unreachable: 404/);
  await assert.rejects(crawlSite('https://site.test/logo.png', { fetchImpl: fakeWeb(SITE).fetchImpl }), /unreachable: not a web page/);
  const empty = { 'https://e.test/': { body: '<html><body><script>render()</script></body></html>' } };
  await assert.rejects(crawlSite('https://e.test/', { fetchImpl: fakeWeb(empty).fetchImpl }), /no text/);
  const down = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
  await assert.rejects(crawlSite('https://down.test/', { fetchImpl: down }), /unreachable: ENOTFOUND/);
});

test('code blocks come out as text, not markup', () => {
  const { text } = htmlToText('<html><body><pre><code><span style="color:red">const</span> x = <b>1</b>;\nnext()</code></pre></body></html>', 'https://site.test/');
  assert.equal(text, 'const x = 1;\nnext()');
});

test('inside pre, highlighted pieces stay on one line', () => {
  const { text } = htmlToText('<pre><div class="line"><button>const</button> <div>x</div> = 1;</div></pre>', 'https://site.test/');
  assert.equal(text, 'const x = 1;');
});
