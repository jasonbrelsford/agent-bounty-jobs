#!/usr/bin/env python3
"""Tell Bing (and every IndexNow search engine: Yandex, Seznam, Naver, and the AI search tools that read
Bing's index, like ChatGPT search and Copilot) which pages changed, right after a deploy.

It reads the live sitemap, compares it with what it sent last time (kept in the Actions cache), and
submits only new or changed URLs. The first run submits everything. Read-only on the site; one POST
to api.indexnow.org. Needs no account: the key file at https://HOST/KEY.txt proves we own the site.

Usage: python3 .github/indexnow/ping.py HOST KEY [--state FILE] [--all] [--dry-run]
"""
import json, re, sys, time, urllib.request, urllib.error

UA = "Mozilla/5.0 (compatible; BrelsfordIndexNow/1.0; +https://brelsfordsoftware.com)"


def get(url, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Cache-Control": "no-cache"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if e.code < 500:
                return e.code, ""
        except Exception as e:  # network blip right after a deploy
            print("  fetch failed:", url, e)
        time.sleep(5 * (i + 1))
    return 0, ""


def sitemap_entries(host):
    """[(url, lastmod or '')] from /sitemap.xml, following one level of sitemap index."""
    out, seen = [], set()
    todo = [f"https://{host}/sitemap.xml"]
    while todo:
        sm = todo.pop(0)
        if sm in seen or len(seen) > 50:
            continue
        seen.add(sm)
        code, body = get(sm)
        if code != 200:
            print(f"  {sm}: HTTP {code}")
            continue
        if "<sitemapindex" in body:
            todo += re.findall(r"<loc>\s*(.*?)\s*</loc>", body)
            continue
        for block in re.findall(r"<url>(.*?)</url>", body, re.S):
            loc = re.search(r"<loc>\s*(.*?)\s*</loc>", block)
            mod = re.search(r"<lastmod>\s*(.*?)\s*</lastmod>", block)
            if loc:
                out.append((loc.group(1).replace("&amp;", "&"), mod.group(1) if mod else ""))
    return out


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) < 2:
        sys.exit(__doc__)
    host, key = args[0], args[1]
    state = sys.argv[sys.argv.index("--state") + 1] if "--state" in sys.argv else ".indexnow-state/sent.json"
    send_all, dry = "--all" in sys.argv, "--dry-run" in sys.argv

    code, body = get(f"https://{host}/{key}.txt")
    if code != 200 or body.strip() != key:
        sys.exit(f"Key file https://{host}/{key}.txt is not live yet (HTTP {code}); not pinging.")

    entries = [(u, m) for u, m in sitemap_entries(host) if u.startswith(f"https://{host}/") or u == f"https://{host}"]
    if not entries:
        sys.exit("No URLs found in the live sitemap; nothing to send.")

    try:
        sent = json.load(open(state))
    except Exception:
        sent = {}
    changed = [u for u, m in entries if send_all or sent.get(u) != m]
    print(f"{host}: {len(entries)} URLs in sitemap, {len(changed)} new or changed")
    if not changed:
        return
    if dry:
        print("\n".join(changed[:50]))
        return

    for i in range(0, len(changed), 10000):
        batch = changed[i:i + 10000]
        payload = json.dumps({"host": host, "key": key, "keyLocation": f"https://{host}/{key}.txt", "urlList": batch}).encode()
        req = urllib.request.Request("https://api.indexnow.org/IndexNow", data=payload,
                                     headers={"Content-Type": "application/json; charset=utf-8", "User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                print(f"  IndexNow: HTTP {r.status} for {len(batch)} URLs")
        except urllib.error.HTTPError as e:
            # 422 = URLs don't match the host/key; 403 = key not valid; 429 = too many. None of these break the site.
            print(f"  IndexNow: HTTP {e.code} {e.read()[:200]!r}")
            if e.code in (403, 422):
                sys.exit(1)
            return

    import os
    os.makedirs(os.path.dirname(state) or ".", exist_ok=True)
    sent.update(dict(entries))
    json.dump(sent, open(state, "w"), indent=0, sort_keys=True)


if __name__ == "__main__":
    main()
