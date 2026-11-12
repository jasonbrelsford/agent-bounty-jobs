// /guides pages: every guide renders with a title, description, canonical link and
// tagged links; the sitemap lists them; stats count views, clicks and sign-ups and
// are readable only with the admin key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./d1shim.mjs";
import { GUIDES, guideRoutes, guideHtml, hubHtml, trackGuide, guideStats, isGuideSlug } from "../.test-build/guides.js";
import { sitemapXml } from "../.test-build/sitemap.js";

const ctx = () => { const p = []; return { waitUntil: (x) => p.push(x), done: () => Promise.all(p) }; };
const get = (path, headers = {}) => new Request(`https://bounty.example.com${path}`, { headers });

test("every guide renders with metadata and unique slugs", () => {
  const slugs = new Set();
  for (const g of GUIDES) {
    assert.ok(!slugs.has(g.slug), `duplicate slug ${g.slug}`);
    slugs.add(g.slug);
    assert.match(g.slug, /^[a-z0-9-]{3,80}$/);
    assert.ok(g.description.length >= 80 && g.description.length <= 170, `${g.slug} description length ${g.description.length}`);
    const html = guideHtml(g.slug);
    assert.ok(html.includes(`<link rel="canonical" href="https://bounty.brelsfordsoftware.com/guides/${g.slug}">`));
    assert.ok(html.includes('<meta name="description"'));
    assert.ok(html.includes('application/ld+json'));
    assert.ok(html.includes(`from=${g.slug}`), `${g.slug} has no tagged link`);
    // internal guide links must point at real guides
    for (const m of html.matchAll(/href="\/guides\/([a-z0-9-]+)"/g)) assert.ok(isGuideSlug(m[1]), `${g.slug} links to missing guide ${m[1]}`);
  }
  assert.ok(GUIDES.length >= 6);
  assert.equal(guideHtml("nope"), null);
  const hub = hubHtml();
  for (const g of GUIDES) assert.ok(hub.includes(`/guides/${g.slug}`));
});

test("routes serve pages, 404 unknown guides and count views", async () => {
  const db = makeD1();
  const c = ctx();
  const env = { DB: db, ADMIN_KEY: "k" };
  const hub = await guideRoutes(get("/guides"), new URL("https://x/guides"), env, c);
  assert.equal(hub.status, 200);
  const g = GUIDES[0].slug;
  const r = await guideRoutes(get(`/guides/${g}`, { "user-agent": "Mozilla/5.0" }), new URL(`https://x/guides/${g}`), env, c);
  assert.equal(r.status, 200);
  await guideRoutes(get(`/guides/${g}`, { "user-agent": "Googlebot/2.1" }), new URL(`https://x/guides/${g}`), env, c);
  const miss = await guideRoutes(get("/guides/not-a-guide"), new URL("https://x/guides/not-a-guide"), env, c);
  assert.equal(miss.status, 404);
  assert.equal(await guideRoutes(get("/arena"), new URL("https://x/arena"), env, c), null);
  await c.done();
  await trackGuide(db, g, "click");
  await trackGuide(db, g, "signup");
  await trackGuide(db, "not-a-guide", "click");
  const s = await guideStats(db, 30);
  const row = s.guides.find((x) => x.slug === g);
  assert.deepEqual([row.view, row.view_bot, row.click, row.signup], [1, 1, 1, 1]);
  assert.equal(s.guides.find((x) => x.slug === "hub").view, 1);
  assert.ok(!s.guides.some((x) => x.slug === "not-a-guide"));
});

test("stats need the admin key", async () => {
  const db = makeD1();
  const u = new URL("https://x/v1/admin/guide-stats");
  const no = await guideRoutes(get("/v1/admin/guide-stats"), u, { DB: db, ADMIN_KEY: "k" }, ctx());
  assert.equal(no.status, 403);
  const unset = await guideRoutes(get("/v1/admin/guide-stats", { "x-admin-key": "" }), u, { DB: db }, ctx());
  assert.equal(unset.status, 403);
  const yes = await guideRoutes(get("/v1/admin/guide-stats", { "x-admin-key": "k" }), u, { DB: db, ADMIN_KEY: "k" }, ctx());
  assert.equal(yes.status, 200);
  assert.ok(Array.isArray((await yes.json()).guides));
});

test("a stats failure never breaks a page", async () => {
  const broken = { prepare() { throw new Error("db down"); } };
  await trackGuide(broken, GUIDES[0].slug, "view");
});

test("sitemap lists the hub and every guide", async () => {
  const xml = await sitemapXml(makeD1(), "https://bounty.example.com");
  assert.ok(xml.includes("<loc>https://bounty.example.com/guides</loc>"));
  for (const g of GUIDES) assert.ok(xml.includes(`<loc>https://bounty.example.com/guides/${g.slug}</loc>`));
});
