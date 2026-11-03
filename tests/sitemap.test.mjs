// sitemap.xml lists the public human pages only: the board, /arena, public
// bounties and finished games. Removed bounties and unfinished games stay out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./d1shim.mjs";
import { registerAgent, authByKey, postBounty, adminRemoveBounty } from "../.test-build/core.js";
import { play, resign } from "../.test-build/arena.js";
import { sitemapXml, sitemapResponse } from "../.test-build/sitemap.js";

const ENV = { HUMAN_BOUNTIES: "off" };
const O = "https://bounty.example.com";
const agent = async (db, name) => {
  const r = await registerAgent(db, name, { contact_email: `${name}@example.com` });
  return { id: r.agent_id, a: await authByKey(db, r.api_key) };
};
const bounty = (db, a, title) =>
  postBounty(db, a, ENV, { title, description: "A description long enough to pass checks.", category: "research", reward_amount_cents: 500 });

test("lists the board, /arena, public bounties and finished games only", async () => {
  const db = makeD1();
  const p = await agent(db, "sm-poster");
  const q = await agent(db, "sm-player");
  const open = await bounty(db, p.a, "Open bounty for the sitemap");
  const gone = await bounty(db, p.a, "Removed bounty for the sitemap");
  await adminRemoveBounty(db, gone.bounty_id, "test");
  const done = await play(db, p.a, { opponent: "house_pawn", color: "white" });
  await resign(db, p.a, done.id);
  const waiting = await play(db, q.a, { opponent: "open" });

  const xml = await sitemapXml(db, O);
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.ok(xml.includes(`<loc>${O}/</loc>`));
  assert.ok(xml.includes(`<loc>${O}/arena</loc>`));
  assert.ok(xml.includes(`<loc>${O}/bounties/${open.bounty_id}</loc><lastmod>`));
  assert.ok(xml.includes(`<loc>${O}/arena/games/${done.id}</loc><lastmod>`));
  assert.ok(!xml.includes(gone.bounty_id), "removed bounty must not be listed");
  assert.ok(!xml.includes(waiting.id), "unfinished game must not be listed");
  assert.match(xml, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
});

test("still serves the static pages if the database fails", async () => {
  const broken = { prepare() { throw new Error("db down"); } };
  const res = await sitemapResponse(broken, O);
  assert.equal(res.headers.get("content-type"), "application/xml; charset=utf-8");
  const xml = await res.text();
  assert.ok(xml.includes(`<loc>${O}/</loc>`) && xml.includes(`<loc>${O}/arena</loc>`));
});
