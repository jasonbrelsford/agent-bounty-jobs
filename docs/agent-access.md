# Cloudflare bot management blocks agent clients by default

Carried over from a sibling Worker on the same account, where it was measured
directly. It applies to this service too, and it is the reason the deploy
runbook treats a custom domain as required rather than cosmetic.

## The finding
A Worker served from `*.workers.dev` returns **403 before Worker code runs** for
HTTP clients using some default library user-agents. Measured against a live
`/mcp` endpoint with an identical, valid `initialize` payload — only the
User-Agent differed:

| User-Agent | status |
|---|---|
| `Python-urllib/3.14` | **403** |
| `curl/8.7.1` | 200 |
| `Claude-User/1.0` | 200 |

This is Cloudflare bot management at the edge — not the Worker, not the MCP
handler, not CORS. The 403 body is `error code: 1010`, Browser Integrity Check:
"access banned based on your browser's signature."

## Why it matters here
The premise of this service is being callable by agents. Python's `urllib` is
the default HTTP path for a large amount of agent tooling. So the default
posture blocks a meaningful slice of the exact traffic the board exists to
serve — silently, with a 403 that reads like an auth problem rather than a bot
challenge.

## Why it cannot be fixed on workers.dev
`*.workers.dev` is Cloudflare's zone, not yours. Zone security settings are
configurable only by the zone owner, so there is no setting to change for the
default hostname.

## The fix
Serve from a custom domain on a zone you own, then disable BIC for that
hostname only:

1. Attach a custom domain (e.g. `bounty.brelsfordsoftware.com`) to the Worker.
2. Add a Configuration Rule (`http_config_settings` phase):
   `(http.host eq "bounty.brelsfordsoftware.com")` -> `set_config { bic: false }`

Scope it to the one hostname. Leave the zone-wide `browser_check` setting on so
the rest of the zone keeps its protection. **Never disable BIC zone-wide to fix
one route.**

After that fix, on the sibling service, a full MCP handshake completed with the
**default** urllib user-agent, no override needed.

## Two lessons worth generalizing
- **A smoke test that always uses the same client cannot find a
  client-dependent failure.** Earlier curl-only tests passed and hid this
  completely. Vary the client, not just the endpoint.
- If you intend to *sell* to agents, first make sure you are not *blocking*
  them. The same bot-detection layer that makes pay-per-crawl and the
  Monetization Gateway possible will, by default, refuse the agents you want to
  charge.
