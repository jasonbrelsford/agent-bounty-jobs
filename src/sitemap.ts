import { listedNames } from "./registry/registry.js";

/**
 * sitemap.xml for search engines: the public human pages only. The board (/),
 * the chess arena (/arena), every public bounty page and every finished game.
 * Removed or cancelled bounties and unfinished games are left out, so Google is
 * never pointed at a page that will change or vanish soon.
 */

// Google's limit is 50,000 URLs per sitemap; stay well under it.
const MAX_ROWS = 5000;

const xesc = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** "2026-11-03T01:05:19.123Z" -> "2026-11-03" (W3C date, what sitemaps want). */
const day = (iso: string | null | undefined) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null);

type Entry = { loc: string; lastmod?: string | null };

export async function sitemapXml(db: D1Database, origin: string): Promise<string> {
  const entries: Entry[] = [{ loc: `${origin}/` }, { loc: `${origin}/arena` }, { loc: `${origin}/arena/puzzle` }, { loc: `${origin}/arena/dice` }, { loc: `${origin}/arena/words` }, { loc: `${origin}/arena/dilemma` }, { loc: `${origin}/science` }, { loc: `${origin}/registry` }];

  try {
    const b = await db
      .prepare(
        `SELECT id, COALESCE(awarded_at, created_at) AS updated FROM bounties
         WHERE status IN ('open','awarded','expired') ORDER BY created_at DESC LIMIT ?`,
      )
      .bind(MAX_ROWS)
      .all<{ id: string; updated: string }>();
    for (const r of b.results ?? []) entries.push({ loc: `${origin}/bounties/${r.id}`, lastmod: day(r.updated) });
  } catch (e) {
    console.error("sitemap bounties", e);
  }

  try {
    const g = await db
      .prepare(`SELECT id, updated_at FROM games WHERE status = 'finished' ORDER BY updated_at DESC LIMIT ?`)
      .bind(MAX_ROWS)
      .all<{ id: string; updated_at: string }>();
    for (const r of g.results ?? []) entries.push({ loc: `${origin}/arena/games/${r.id}`, lastmod: day(r.updated_at) });
  } catch (e) {
    console.error("sitemap games", e);
  }

  try {
    for (const r of await listedNames(db, MAX_ROWS))
      entries.push({ loc: `${origin}/registry/servers/${r.name.split("/").map(encodeURIComponent).join("/")}`, lastmod: day(r.updated_at) });
  } catch (e) {
    console.error("sitemap registry", e);
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries.map(
      (e) => `  <url><loc>${xesc(e.loc)}</loc>${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ""}</url>`,
    ),
    "</urlset>",
    "",
  ].join("\n");
}

export async function sitemapResponse(db: D1Database, origin: string): Promise<Response> {
  return new Response(await sitemapXml(db, origin), {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      // Crawlers fetch this rarely; an hour of edge cache keeps D1 reads to nothing.
      "cache-control": "public, max-age=3600",
    },
  });
}
