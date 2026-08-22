# Cloudflare bot management blocks agent clients by default

Measured on this service, on this domain. The finding was first seen on a sibling
Worker in the same account; everything below is a first-party reproduction during
the initial deploy of `bounty.brelsfordsoftware.com`, and it is the reason the
runbook treats a custom domain as required rather than cosmetic.

## The finding

A Worker reachable at a hostname with Browser Integrity Check active returns
**403 before Worker code runs** for HTTP clients whose default user-agent BIC
dislikes. Measured immediately after deploy, custom domain attached, rule not yet
applied — identical requests, only the client differing:

| Client | `/v1` | `/` | `/llms.txt` | `/.well-known/mcp.json` |
|---|---|---|---|---|
| `curl/8.7.1` | 200 (30/30) | 200 | 200 | 200 |
| `Python-urllib/3.14` | **403 (6/6)** | **403** | **403** | **403** |

Not the Worker, not the MCP handler, not CORS: `wrangler tail` recorded **zero
exceptions** across the failing window, because the request never reached the
script. The 403 body is `error code: 1010` — "access banned based on your
browser's signature".

## Why it matters here

The premise of this service is being callable by agents, and `urllib` is the
default HTTP path for a large amount of agent tooling. The out-of-the-box posture
therefore blocks a meaningful slice of the exact traffic the board exists to
serve — silently, with a 403 that reads like an auth failure rather than a bot
challenge, so the agent author debugs their credentials instead.

## Why it cannot be fixed on workers.dev

`*.workers.dev` is Cloudflare's zone, not yours. Zone security settings are
configurable only by the zone owner, so there is no setting to change for the
default hostname. Publishing a `workers.dev` URL means silently 403ing those
clients with no remedy available to you.

## The fix

Serve from a custom domain on a zone you own, then disable BIC for that hostname
only:

1. Attach the custom domain to the Worker (`routes` with `custom_domain: true`).
2. Add a Configuration Rule in the zone:
   - **Expression:** `http.host eq "bounty.brelsfordsoftware.com"`
   - **Setting:** Browser Integrity Check → **off**

Match on **host, not path**. Every surface needs it — `/` (dashboard), `/v1`
(REST), `/mcp`, and the discovery files — and a path-scoped rule leaves most of
the board blocked.

Leave the zone-wide `browser_check` setting on so the rest of the zone keeps its
protection. **Never disable BIC zone-wide to fix one hostname.**

### After the rule

| Check | Result |
|---|---|
| `Python-urllib` across 6 paths | **36/36 → 200** |
| UA sweep: curl, urllib, python-requests, node-fetch, Go-http-client, Claude-User | **all 200** |
| MCP `initialize` with the **default** urllib UA | **200**, `agent-bounty-jobs@0.1.0-beta` |

No user-agent override needed anywhere.

## Two operational notes worth having in advance

**The rule propagates colo by colo.** For roughly a minute afterwards, requests
still 403 intermittently — successes and failures landing in *different*
Cloudflare colos (visible as `cf-ray` suffixes `ORD` vs `YYZ`). It looks like a
flaky fix and is not one. Re-test after a minute before concluding anything.

**Distinguish this from route propagation.** Immediately after the first deploy,
`/` and `/v1/bounties` returned intermittent **500s** — unrelated to BIC, and
also propagation, this time of the custom-domain route. `wrangler tail` showing
zero exceptions is what separates "the edge is still settling" from "your code is
broken". Both resolve on their own; neither is worth debugging in the first
minute.

**Check what the rule template brought with it.** Cloudflare's "Browser Integrity
Check" Configuration Rule template can arrive carrying additional settings — ours
picked up Email Obfuscation alongside BIC. Harmless here (Cloudflare applies it
only to HTML responses, so the JSON API and MCP endpoint are untouched), but it
is worth trimming to keep the rule's intent legible later.

## Two lessons worth generalizing

- **A smoke test that always uses the same client cannot find a client-dependent
  failure.** curl-only testing passed cleanly and hid this completely. Vary the
  client, not just the endpoint.
- If you intend to *sell* to agents, first make sure you are not *blocking* them.
  The same bot-detection layer that makes pay-per-crawl and the Monetization
  Gateway possible will, by default, refuse the agents you want to charge.
