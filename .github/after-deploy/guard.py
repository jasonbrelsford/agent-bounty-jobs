#!/usr/bin/env python3
"""After-deploy guard: checks the live site after each production deploy and, if it is broken,
rolls main back one step to the last deploy that passed, then checks again.

Read-only against the site: it only sends GET requests. No sign-ups, no form posts, no paid calls.

Usage (from .github/workflows/after-deploy.yml):
  guard.py check                 run the site checks once, exit 1 if any fail
  guard.py run --sha SHA         full flow for a deploy of SHA on main (see "What happens" in README.md)
  guard.py run --dry-run [--simulate-failure]
                                 the same decisions, printed only: nothing is pushed, tagged or filed

Config: .github/after-deploy/checks.json (next to this file). Standard library only.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG = json.loads((HERE / "checks.json").read_text())
REPO = os.environ.get("GITHUB_REPOSITORY", "")
BRANCH = CONFIG.get("branch", "main")
CONTEXT = "after-deploy"  # commit status name; a green one marks a deploy as known good
MARKER = "Auto-rollback-of:"  # trailer on every rollback commit; a rollback is never rolled back
LABEL = "deploy-rollback"
# Says "bot", "monitor" and "uptime" so the sites' own visit counters file these requests under bots, not people.
UA = "brelsford-uptime-monitor-bot/1 (after-deploy check; +https://github.com/" + (REPO or "jasonbrelsford") + ")"
# Text that only appears when a Worker crashed or Cloudflare could not reach it.
CRASH = ["worker threw exception", "error code: 1101", "error code: 1102", "error 1101", "error code: 1042"]

SETTLE_SECONDS = int(os.environ.get("AFTER_DEPLOY_SETTLE", "20"))
RETRY_SECONDS = int(os.environ.get("AFTER_DEPLOY_RETRY", "30"))
ATTEMPTS = 3
WAIT_DEPLOY_MINUTES = int(os.environ.get("AFTER_DEPLOY_WAIT_MINUTES", "20"))
POLL_SECONDS = int(os.environ.get("AFTER_DEPLOY_POLL", "30"))


# ---------------------------------------------------------------- output helpers

def say(msg):
    print(msg, flush=True)


def annotate(level, title, msg):
    """level: notice | warning | error. Annotations show on the run and are readable via the checks API."""
    msg = msg.replace("%", "%25").replace("\r", "").replace("\n", "%0A")
    print(f"::{level} title={title}::{msg}", flush=True)


def summary(md):
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a") as f:
            f.write(md + "\n")


# ---------------------------------------------------------------- site checks

def fetch(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*", "Cache-Control": "no-cache"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.headers.get("content-type", ""), r.read(3_000_000).decode("utf-8", "replace"), r.geturl()
    except urllib.error.HTTPError as e:
        body = e.read(200_000).decode("utf-8", "replace") if e.fp else ""
        return e.code, e.headers.get("content-type", "") if e.headers else "", body, url
    except Exception as e:  # DNS, TLS, timeout, reset
        return 0, "", f"{type(e).__name__}: {e}", url


def run_one(base, c):
    """Returns None when the check passes, else a one-line reason."""
    url = base.rstrip("/") + c["path"]
    want = c.get("status", 200)
    code, ctype, body, final = fetch(url)
    if code != want:
        return f"{c['path']} answered {code or 'no response'} (wanted {want}){': ' + body[:160] if code == 0 else ''}"
    low = body.lower()
    if 200 <= want < 300:
        for m in CRASH:
            if m in low:
                return f"{c['path']} shows a Cloudflare error page ({m})"
    for text in c.get("contains", []):
        if text.lower() not in low:
            return f"{c['path']} is missing the text {text!r}"
    if c.get("type") and c["type"] not in ctype:
        return f"{c['path']} came back as {ctype or 'no content type'} (wanted {c['type']})"
    if c.get("json") or c.get("json_has"):
        try:
            data = json.loads(body)
        except ValueError:
            return f"{c['path']} is not valid JSON"
        for k in c.get("json_has", []):
            if not isinstance(data, dict) or k not in data:
                return f"{c['path']} JSON has no {k!r}"
    if c.get("final_host") and c["final_host"] not in final:
        return f"{c['path']} ended up at {final} (wanted {c['final_host']})"
    n = c.get("sitemap_sample", 0)
    if n:
        locs = re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", body)
        if "<sitemapindex" in low and locs:  # an index: open the first child sitemap
            code2, _, body2, _ = fetch(locs[0])
            if code2 != 200:
                return f"{c['path']} lists {locs[0]}, which answered {code2}"
            locs = re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", body2)
        if not locs:
            return f"{c['path']} lists no pages"
        picks = sorted({0, len(locs) // 2, len(locs) - 1})[:n] if n <= 3 else locs[:n]
        for i in picks:
            u = locs[i] if isinstance(i, int) else i
            code3, _, body3, _ = fetch(u)
            if code3 != 200:
                return f"a page listed in {c['path']}, {u}, answered {code3}"
            if any(m in body3.lower() for m in CRASH):
                return f"a page listed in {c['path']}, {u}, shows a Cloudflare error page"
    return None


def run_checks(quiet=False):
    """Every check gets up to ATTEMPTS tries, RETRY_SECONDS apart; only a check that fails every try counts."""
    todo = [(s, c) for s in CONFIG["sites"] for c in s["checks"]]
    failures = {}
    for attempt in range(1, ATTEMPTS + 1):
        failures = {}
        for s, c in todo:
            why = run_one(s["base"], c)
            if why:
                failures[(s["name"], c["path"])] = (s, c, f"{s['name']}: {why}")
        if not failures:
            break
        if attempt < ATTEMPTS:
            say(f"attempt {attempt}: {len(failures)} check(s) failed, trying those again in {RETRY_SECONDS}s")
            todo = [(s, c) for (s, c, _) in failures.values()]
            time.sleep(RETRY_SECONDS)
    total = sum(len(s["checks"]) for s in CONFIG["sites"])
    reasons = [r for (_, _, r) in failures.values()]
    if not quiet:
        if reasons:
            for r in reasons:
                annotate("error", "site check failed", r)
        else:
            annotate("notice", "site checks passed", f"all {total} checks passed on " + ", ".join(s["name"] for s in CONFIG["sites"]))
        summary(f"### Site checks\n{total - len(reasons)} of {total} passed\n" + "".join(f"- ❌ {r}\n" for r in reasons))
    return reasons, total


# ---------------------------------------------------------------- git and GitHub

def sh(*args, check=True, capture=True):
    r = subprocess.run(args, text=True, capture_output=capture)
    if check and r.returncode != 0:
        raise RuntimeError(f"{' '.join(args)} failed: {r.stderr.strip()[:500]}")
    return (r.stdout or "").strip()


def git(*args, check=True):
    return sh("git", *args, check=check)


def api(path, method="GET", fields=None, check=True):
    cmd = ["gh", "api", "-X", method, path]
    for k, v in (fields or {}).items():
        cmd += ["-f", f"{k}={v}"]
    out = sh(*cmd, check=check)
    try:
        return json.loads(out) if out else None
    except ValueError:
        return None


def paths():
    return CONFIG.get("rollback_paths", ["."])


def touches_paths(commit):
    if paths() == ["."]:
        return True
    parent = git("rev-parse", f"{commit}^1", check=False)
    if not parent:
        return True
    return bool(git("diff", "--name-only", parent, commit, "--", *paths()))


def deployer_state(sha):
    """('done', all_succeeded, names) once every deploy of this commit finished, ('running', None, names) before."""
    d = CONFIG.get("deployers", {})
    seen, running, ok = [], False, True
    prefix = d.get("check_prefix")
    if prefix:
        runs = api(f"repos/{REPO}/commits/{sha}/check-runs?per_page=100") or {}
        for r in runs.get("check_runs", []):
            if r["name"].startswith(prefix):
                seen.append(r["name"])
                if r["status"] != "completed":
                    running = True
                elif r["conclusion"] != "success":
                    ok = False
    for wf in d.get("workflows", []):
        runs = api(f"repos/{REPO}/actions/runs?head_sha={sha}&per_page=50") or {}
        mine = [r for r in runs.get("workflow_runs", []) if r["name"] == wf and r["head_branch"] == BRANCH]
        if mine:
            latest = max(mine, key=lambda r: r["run_number"])
            seen.append(wf)
            if latest["status"] != "completed":
                running = True
            elif latest["conclusion"] != "success":
                ok = False
    if running:
        return "running", None, seen
    return "done", (ok and bool(seen)), seen


def set_status(sha, state, desc, dry):
    say(f"status {state} on {sha[:7]}: {desc}")
    if not dry:
        api(f"repos/{REPO}/statuses/{sha}", "POST",
            {"state": state, "context": CONTEXT, "description": desc[:140]}, check=False)


def last_good(before_sha):
    """Newest earlier commit on main whose deploy passed these checks (green after-deploy status)."""
    revs = git("rev-list", "--first-parent", "-n", "300", f"{before_sha}^", check=False).split()
    looked = 0
    for c in revs:
        if not touches_paths(c):
            continue
        looked += 1
        if looked > 40:
            break
        st = api(f"repos/{REPO}/commits/{c}/statuses?per_page=100", check=False) or []
        for s in st:  # newest first
            if s.get("context") == CONTEXT:
                if s.get("state") == "success":
                    return c, "the last deploy that passed these checks"
                break
    parent = git("rev-parse", f"{before_sha}^1", check=False)
    return (parent, "the commit before it (no deploy has passed these checks yet)") if parent else (None, "")


def subject(sha):
    return git("log", "-1", "--format=%s", sha)


def pr_link(sha):
    prs = api(f"repos/{REPO}/commits/{sha}/pulls", check=False) or []
    return f"[#{prs[0]['number']} {prs[0]['title']}]({prs[0]['html_url']})" if prs else f"commit {sha[:7]}"


def commit_link(sha):
    return f"[{sha[:7]}](https://github.com/{REPO}/commit/{sha})"


def open_issue(title, body, dry):
    say(f"issue: {title}")
    if dry:
        say(body)
        annotate("notice", "dry run: would open an issue", title)
        return None
    sh("gh", "label", "create", LABEL, "--repo", REPO, "--color", "b60205",
       "--description", "Filed by the after-deploy check", "--force", check=False)
    return sh("gh", "issue", "create", "--repo", REPO, "--title", title, "--label", LABEL, "--body", body, check=False)


def comment_on_open_issue(body, dry, once_marker=None):
    issues = api(f"repos/{REPO}/issues?state=open&labels={LABEL}&per_page=1", check=False) or []
    if not issues:
        return
    n = issues[0]["number"]
    if once_marker:
        if once_marker in (issues[0].get("body") or ""):
            return
        for cm in api(f"repos/{REPO}/issues/{n}/comments?per_page=100", check=False) or []:
            if once_marker in (cm.get("body") or ""):
                return
    say(f"comment on #{n}")
    if not dry:
        api(f"repos/{REPO}/issues/{n}/comments", "POST", {"body": body + (f"\n\n{once_marker}" if once_marker else "")}, check=False)


def wait_for_deploy(sha):
    """Waits until every deploy of `sha` finished. Returns (finished, succeeded, names)."""
    deadline = time.time() + WAIT_DEPLOY_MINUTES * 60
    while True:
        state, ok, seen = deployer_state(sha)
        if state == "done" and seen:
            return True, ok, seen
        if time.time() > deadline:
            return False, False, seen
        time.sleep(POLL_SECONDS)


# ---------------------------------------------------------------- the flow

def run(args):
    dry = args.dry_run
    git("fetch", "--quiet", "--depth=300", "origin", BRANCH, check=False)
    head = git("rev-parse", f"origin/{BRANCH}")
    sha = args.sha or head
    sites = ", ".join(s["name"] for s in CONFIG["sites"])

    # 1. Only judge the newest deploy. A newer commit that changes the site means a newer deploy is on its way.
    if sha != head:
        if subprocess.run(["git", "merge-base", "--is-ancestor", sha, head]).returncode != 0:
            say(f"{sha[:7]} is not on {BRANCH}; nothing to do")
            return 0
        newer = [c for c in git("rev-list", f"{sha}..{head}").split() if touches_paths(c)]
        if newer:
            say(f"{sha[:7]} is no longer the newest deploy ({len(newer)} newer change(s) on {BRANCH}); the newer deploy will be checked")
            return 0

    # 2. Wait until every deploy of this commit has finished, so the check sees the new version.
    state, deploy_ok, seen = deployer_state(sha)
    if state == "running" and not dry:
        say(f"a deploy of {sha[:7]} is still running ({', '.join(seen)}); the check runs when it finishes")
        return 0
    say(f"deploys of {sha[:7]}: {', '.join(seen) or 'none found'} -> {'succeeded' if deploy_ok else 'not all succeeded'}")

    # 3. Check the live site.
    if not args.simulate_failure:
        time.sleep(0 if dry else SETTLE_SECONDS)
        reasons, total = run_checks()
    else:
        reasons, total = ["(simulated failure, dry run)"], 1
        say("simulating a failed check to show what the rollback would do")

    is_rollback = MARKER in git("log", "-1", "--format=%B", sha)
    if not reasons:
        if deploy_ok:
            set_status(sha, "success", f"{sites}: all {total} checks passed after deploy", dry)
        else:
            say("site is healthy, but not every deploy of this commit succeeded, so it is not marked as known good")
        if is_rollback:
            comment_on_open_issue(f"The rollback ({commit_link(sha)}) is live and all site checks pass.", dry, "<!-- rollback-ok -->")
        return 0

    set_status(sha, "failure", f"{len(reasons)} site check(s) failed after deploy", dry)
    failed_list = "\n".join(f"- {r}" for r in reasons)

    # 4. Loop guard: a rollback commit is never rolled back. A person takes it from here.
    if is_rollback:
        comment_on_open_issue(
            f"Still broken after the rollback ({commit_link(sha)}). I did not roll back further; this needs a person.\n\n{failed_list}",
            dry, "<!-- rollback-still-failing -->")
        return 1

    good, why_good = last_good(sha)
    bad_title = subject(sha)
    head_line = f"{pr_link(sha)} ({commit_link(sha)})"
    if not good:
        open_issue(f"Site checks failed after deploy of {sha[:7]}; no earlier deploy to go back to",
                   f"After deploying {head_line}, these checks failed on {sites}:\n\n{failed_list}\n\nThere is no earlier commit to roll back to, so nothing was changed.", dry)
        return 1

    changed = git("diff", "--name-only", good, head, "--", *paths()).split()
    if not changed:
        open_issue(f"{sites} is failing, but the code is the same as the last good deploy",
                   f"These checks failed after deploying {head_line}:\n\n{failed_list}\n\n"
                   f"The code on {BRANCH} matches {commit_link(good)} ({why_good}), so rolling back would change nothing. "
                   "This looks like an outage outside the code (Cloudflare, a database, a third-party API). Nothing was changed.", dry)
        return 1

    holds = [f for f in changed if any(re.search(p, f) for p in CONFIG.get("hold_paths", []))]
    if holds:
        open_issue(f"Site checks failed after deploy of {sha[:7]}; not rolled back because it changed the database",
                   f"After deploying {head_line}, these checks failed on {sites}:\n\n{failed_list}\n\n"
                   f"I did not roll back on my own, because the change includes database or storage migrations "
                   f"({', '.join(holds[:5])}), and going back to old code over a new database can make things worse. "
                   f"To roll back by hand: Cloudflare dashboard > Workers & Pages > the Worker > Deployments > roll back to the previous version.", dry)
        return 1

    undone = git("log", "--format=%h %s", f"{good}..{head}", "--", *paths()).splitlines()
    say(f"rolling back to {good[:7]} ({why_good}); this undoes {len(undone)} change(s)")
    if dry:
        say("dry run: would commit the files of " + good[:7] + " onto " + BRANCH + " for: " + " ".join(paths()))
        say("dry run: changes that would be undone:\n  " + "\n  ".join(undone[:20]))
        if CONFIG.get("redeploy_workflows"):
            say("dry run: would then start: " + ", ".join(CONFIG["redeploy_workflows"]))
        say("dry run: would then wait for the deploy, check again and open an issue naming " + head_line)
        annotate("notice", "dry run: rollback plan",
                 f"would roll {BRANCH} back to {good[:7]} ({why_good}), undoing {len(undone)} change(s): "
                 + "; ".join(undone[:5]) + (f"; then start {', '.join(CONFIG['redeploy_workflows'])}" if CONFIG.get("redeploy_workflows") else "")
                 + "; then wait for the deploy, check again and open an issue")
        return 1

    # 5. One step back: a new commit on main whose site files are exactly those of the last good deploy.
    git("config", "user.name", "github-actions[bot]")
    git("config", "user.email", "41898099+github-actions[bot]@users.noreply.github.com")
    pushed = None
    for _ in range(2):
        git("fetch", "--quiet", "--depth=300", "origin", BRANCH)
        tip = git("rev-parse", f"origin/{BRANCH}")
        if tip != head and any(touches_paths(c) for c in git("rev-list", f"{head}..{tip}").split()):
            say("main changed while rolling back; leaving it to the newer deploy's check")
            return 1
        git("checkout", "--quiet", "-B", "after-deploy-rollback", tip)
        git("restore", f"--source={good}", "--staged", "--worktree", "--", *paths())
        if not git("diff", "--cached", "--name-only"):
            say("nothing to roll back after all")
            return 1
        msg = (f"Roll back to the last good deploy ({good[:7]})\n\n"
               f"The after-deploy check found {sites} broken after {sha[:7]} \"{bad_title}\":\n{failed_list}\n\n"
               f"This restores the site files of {good[:7]} ({why_good}).\n\n"
               f"{MARKER} {sha}\nRestores: {good}\n")
        git("commit", "--quiet", "-m", msg)
        if subprocess.run(["git", "push", "--quiet", "origin", f"HEAD:{BRANCH}"]).returncode == 0:
            pushed = git("rev-parse", "HEAD")
            break
        time.sleep(5)
    if not pushed:
        open_issue(f"Site checks failed after deploy of {sha[:7]}; the rollback could not be pushed",
                   f"After deploying {head_line}, these checks failed on {sites}:\n\n{failed_list}\n\nI could not push the rollback to {BRANCH}. Nothing was changed.", False)
        return 1
    say(f"pushed rollback {pushed[:7]}")

    for wf in CONFIG.get("redeploy_workflows", []):
        say(f"starting {wf} on {BRANCH}")
        sh("gh", "workflow", "run", wf, "--repo", REPO, "--ref", BRANCH, check=False)

    # 6. Wait for the rollback to deploy, then check again.
    time.sleep(POLL_SECONDS)
    finished, ok, seen = wait_for_deploy(pushed)
    if finished:
        time.sleep(SETTLE_SECONDS)
        again, total = run_checks()
    else:
        again = ["the rollback did not finish deploying within %d minutes" % WAIT_DEPLOY_MINUTES]
    if not again and ok:
        set_status(pushed, "success", f"{sites}: all {total} checks passed after rollback", False)
    elif again:
        set_status(pushed, "failure", "still failing after the rollback", False)
    recheck = ("✅ After the rollback deployed, all site checks pass." if not again else
               "❌ Still failing after the rollback, and I will not roll back further. This needs a person:\n" +
               "\n".join(f"- {r}" for r in again))
    body = (f"**What broke:** after deploying {pr_link(sha)} ({commit_link(sha)}), these checks failed on {sites}:\n\n{failed_list}\n\n"
            f"**What I did:** rolled {BRANCH} back one step to {commit_link(good)}, {why_good}, with {commit_link(pushed)}"
            + (f", then started {', '.join(CONFIG['redeploy_workflows'])}" if CONFIG.get("redeploy_workflows") else "")
            + f". That undid {len(undone)} change(s):\n\n" + "\n".join(f"- {u}" for u in undone[:20])
            + f"\n\n**Re-check:** {recheck}\n\n"
            "**To ship the change again:** fix it in a new pull request. Its changes are still in the history; "
            f"`git revert {pushed[:7]}` brings them back as they were.\n\n<!-- rollback-ok -->"
            + ("" if not again else " <!-- rollback-still-failing -->"))
    open_issue(f"Rolled back {sites}: {bad_title[:70]}", body, False)
    return 1


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check")
    r = sub.add_parser("run")
    r.add_argument("--sha", default="")
    r.add_argument("--dry-run", action="store_true")
    r.add_argument("--simulate-failure", action="store_true")
    args = ap.parse_args()
    if args.cmd == "check":
        reasons, _ = run_checks()
        return 1 if reasons else 0
    if args.simulate_failure and not args.dry_run:
        sys.exit("--simulate-failure only works with --dry-run")
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
