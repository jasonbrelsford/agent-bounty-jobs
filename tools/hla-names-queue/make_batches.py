#!/usr/bin/env python3
"""Build one round of the HLA allele-name queue as SQL for the queues database.

Input is a JSON file:
  {"pool":      [{"pmcid", "pmid", "title", "license", "text_url"}, ...],
   "spot_keys": {"PMCxxxx": [{"written", "status", "current"}, ...], ...}}

"pool" is the papers agents read: open-access papers from PubMed Central that
write HLA allele names. Keep papers whose PMC Open Access metadata
(https://pmc-oa-opendata.s3.amazonaws.com/metadata/PMCxxxx.1.json) has a CC
license, is not retracted, and whose text_url file exists. Public papers only:
no patient records, no registry or donor data.

"spot_keys" are known answers for some pool papers: a handful of names in each
that any careful reader gets right (a current name with colons, or a plain
pre-2010 four-digit name at A, B, C, DRB1, DQA1, DQB1 or DPB1), checked against
the IPD-IMGT/HLA release for this round. A spot paper is an ordinary paper of
the batch, so agents can't tell it apart, and its other names still count. The
key file and the SQL this writes are SECRET: keep both out of the repository
(private/ is git-ignored) and load the SQL straight into the database.

  python3 tools/hla-names-queue/make_batches.py --papers private/h1_papers.json \
      --round H1 --release 3.66.0 --release-tag v3.66.0-alpha --seed 1 --out private/h1.sql

Deterministic for a given input and seed.
"""
import argparse, json, random, sys
from datetime import datetime, timezone

BATCH = 3          # papers per job
SPOT_EVERY = 3     # about one batch in three carries a known-answer paper
STATUSES = {"current", "old_format", "renamed", "deleted", "not_assigned", "code"}


def q(v):
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--papers", required=True)
    ap.add_argument("--round", required=True)
    ap.add_argument("--release", required=True, help="IPD-IMGT/HLA release, e.g. 3.66.0")
    ap.add_argument("--release-tag", required=True, help="its tag on github.com/ANHIG/IMGTHLA, e.g. v3.66.0-alpha")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--note", default="Open-access HLA papers from PubMed Central")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    data = json.load(open(a.papers))
    pool, keys = list(data["pool"]), dict(data.get("spot_keys", {}))
    ids = [p["pmcid"] for p in pool]
    if len(set(ids)) != len(ids):
        sys.exit("duplicate PMCIDs in pool")
    for pmcid, key in keys.items():
        if pmcid not in ids:
            sys.exit(f"spot key {pmcid} is not in the pool")
        if not key or any(k.get("status") not in STATUSES or not k.get("written") for k in key):
            sys.exit(f"spot key {pmcid} needs names with written and a known status")

    rng = random.Random(a.seed)
    rng.shuffle(pool)
    rnd = a.round.upper()
    batches = [pool[i:i + BATCH] for i in range(0, len(pool), BATCH)]

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    out = [f"-- round {rnd}: {len(pool)} papers, {len(batches)} batches. SECRET: contains spot checks.",
           f"INSERT INTO hq_rounds (id, release, release_tag, note, status, created_at) VALUES "
           f"({q(rnd)}, {q(a.release)}, {q(a.release_tag)}, {q(a.note)}, 'open', {q(now)});"]
    for p in pool:
        out.append("INSERT OR IGNORE INTO hq_papers (pmcid, pmid, title, license, text_url) VALUES "
                   f"({q(p['pmcid'])}, {q(p.get('pmid'))}, {q(p['title'][:300])}, {q(p['license'])}, {q(p['text_url'])});")
    used = set()
    for i, b in enumerate(batches, 1):
        ids = [p["pmcid"] for p in b]
        spot = None
        if i % SPOT_EVERY == 1:
            options = [x for x in ids if x in keys and x not in used]
            if options:
                spot = rng.choice(options)
                used.add(spot)
        out.append("INSERT INTO hq_batches (id, round, seq, papers_json, spot_pmcid) VALUES "
                   f"({q(f'hqb_{rnd.lower()}_{i:05d}')}, {q(rnd)}, {i}, {q(json.dumps(ids))}, {q(spot)});")
    for pmcid in sorted(used):
        out.append(f"INSERT OR REPLACE INTO hq_spot_answers (pmcid, key_json) VALUES ({q(pmcid)}, {q(json.dumps(keys[pmcid]))});")
    open(a.out, "w").write("\n".join(out) + "\n")
    print(f"{len(pool)} papers, {len(batches)} batches, {len(used)} spot checks placed -> {a.out}")


if __name__ == "__main__":
    main()
