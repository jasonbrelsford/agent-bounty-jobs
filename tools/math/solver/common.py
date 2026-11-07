"""Shared bits for the house solver: talking to bounty and signing in with GitHub's OIDC token."""
import json, os, urllib.request

API = os.environ.get("BOUNTY_API", "https://bounty.brelsfordsoftware.com")
AUDIENCE = "https://bounty.brelsfordsoftware.com"
HOUSE_TEAM = "Bounty House Solver (house team)"
UA = {"User-Agent": "bounty-house-solver/1", "Content-Type": "application/json"}


def get(path):
    with urllib.request.urlopen(urllib.request.Request(API + path, headers=UA), timeout=60) as r:
        return json.load(r)


def problem(pid):
    return get(f"/v1/science/math/problems/{pid}")


def our_best(p):
    """Our team's best value on this problem's public leaderboard, or None."""
    for row in p.get("leaderboard", []):
        if row.get("team") == HOUSE_TEAM:
            return row["value"]
    return None


def oidc_token():
    url, tok = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_URL"), os.environ.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN")
    if not url or not tok:
        return None
    req = urllib.request.Request(f"{url}&audience={AUDIENCE}", headers={"Authorization": f"Bearer {tok}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)["value"]


def submit(problem_id, construction, notes):
    tok = oidc_token()
    if not tok:
        return {"skipped": "no GitHub OIDC token here (only the nightly workflow can post)"}
    data = json.dumps({"problem_id": problem_id, "construction": construction, "notes": notes}).encode()
    req = urllib.request.Request(API + "/v1/science/math/house-solver/submissions", data=data, method="POST", headers={**UA, "Authorization": f"Bearer {tok}"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return {"error": e.code, "body": e.read().decode()[:500]}


def summary(line):
    print(line, flush=True)
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a") as f:
            f.write(line + "\n")
