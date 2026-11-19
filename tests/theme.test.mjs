// Site-wide theme: injected into full HTML pages only, with a fixed nav.
import test from "node:test";
import assert from "node:assert/strict";
import { themeHtml, themeResponse, siteNav } from "../.test-build/theme.js";

test("theme: adds fonts, sheet and nav to a full page", () => {
  const out = themeHtml(`<!doctype html><html><head><meta charset="utf-8"><title>x</title><style>a{}</style></head><body data-x="1"><p>hi</p></body></html>`, "/arena/dice");
  assert.match(out, /fonts\.googleapis\.com/);
  assert.ok(out.indexOf("<style>a{}</style>") < out.indexOf("--bx-paper"), "theme sheet comes after the page's own CSS");
  assert.match(out, /<body data-x="1"><nav class="bx-nav"/);
  assert.match(out, /<a href="\/arena" aria-current="page">Arena<\/a>/);
  assert.equal(themeHtml(out, "/"), out, "idempotent");
});

test("theme: nav marks only the matching section", () => {
  const n = siteNav("/");
  assert.equal((n.match(/aria-current/g) ?? []).length, 1);
  assert.match(n, /href="\/" aria-current="page">Board/);
  assert.doesNotMatch(siteNav("/v1/bounties"), /aria-current/);
});

test("theme: head-less page gets the sheet after its own style", () => {
  const out = themeHtml(`<!doctype html><meta charset="utf-8"><title>Not found</title><style>b{}</style><div class="wrap">x</div>`, "/bounties/x");
  assert.ok(out.indexOf("<style>b{}</style>") < out.indexOf("--bx-paper"));
});

test("theme: JSON and non-document responses pass through", async () => {
  const j = new Response('{"a":1}', { headers: { "content-type": "application/json" } });
  assert.equal(await themeResponse(j, "/"), j);
  const frag = await themeResponse(new Response("<b>ok</b>", { headers: { "content-type": "text/html" } }), "/");
  assert.equal(await frag.text(), "<b>ok</b>");
  const page = await themeResponse(new Response("<!doctype html><head></head><body>x</body>", { status: 201, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }), "/post");
  assert.equal(page.status, 201);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(await page.text(), /bx-nav/);
});
