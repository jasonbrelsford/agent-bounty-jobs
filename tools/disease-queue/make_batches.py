#!/usr/bin/env python3
"""Build one round of the rare disease paper queue as SQL for the queues database.

Input is a JSON file:
  {"pool":  [{"pmcid", "pmid", "title", "license", "text_url"}, ...],
   "spots": [{"pmcid", "pmid", "title", "license", "text_url", "drug", "disease_terms": [...]}, ...]}

"pool" is the papers agents read. Pick them with a PubMed search limited to the
"pubmed pmc open access" filter, then keep papers whose PMC Open Access metadata
(https://pmc-oa-opendata.s3.amazonaws.com/metadata/PMCxxxx.1.json) has a CC
license, is not retracted, and whose text_url file exists.

"spots" are papers with a known answer: the drug in the title treating the
disease in the title. Pick them from the same years as the pool so they can't be
told apart. The spot list and the SQL this writes are SECRET: keep both out of
the repository (private/ is git-ignored) and load the SQL straight into the
database.

  python3 tools/disease-queue/make_batches.py --papers private/d1_papers.json \
      --round D1 --seed 1 --out private/d1.sql

Deterministic for a given input and seed.
"""
import argparse, json, random, sys
from datetime import datetime, timezone

BATCH = 3          # papers an agent reads per job, before any spot check
SPOT_EVERY = 3     # about one batch in three hides a known-answer paper
SPOT_REUSE = 2     # each known-answer paper is used at most this many times


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
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--note", default="Open-access rare disease case reports and small trials from PubMed Central")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    data = json.load(open(a.papers))
    pool, spots = list(data["pool"]), list(data.get("spots", []))
    spot_ids = {s["pmcid"] for s in spots}
    pool = [p for p in pool if p["pmcid"] not in spot_ids]
    if len({p["pmcid"] for p in pool}) != len(pool):
        sys.exit("duplicate PMCIDs in pool")
    for s in spots:
        if not s.get("drug") or not s.get("disease_terms"):
            sys.exit(f"spot {s['pmcid']} needs drug and disease_terms")

    rng = random.Random(a.seed)
    rng.shuffle(pool)
    rnd = a.round.upper()
    batches = [pool[i:i + BATCH] for i in range(0, len(pool), BATCH)]
    spot_cycle = [s for s in spots for _ in range(SPOT_REUSE)]
    rng.shuffle(spot_cycle)

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    out = [f"-- round {rnd}: {len(pool)} papers, {len(batches)} batches. SECRET: contains spot checks.",
           f"INSERT INTO dq_rounds (id, note, status, created_at) VALUES ({q(rnd)}, {q(a.note)}, 'open', {q(now)});"]
    for p in pool + spots:
        out.append("INSERT OR IGNORE INTO dq_papers (pmcid, pmid, title, license, text_url) VALUES "
                   f"({q(p['pmcid'])}, {q(p.get('pmid'))}, {q(p['title'][:300])}, {q(p['license'])}, {q(p['text_url'])});")
    for s in spots:
        out.append(f"INSERT OR REPLACE INTO dq_spot_answers (pmcid, drug, disease_terms_json) VALUES "
                   f"({q(s['pmcid'])}, {q(s['drug'].lower())}, {q(json.dumps([t.lower() for t in s['disease_terms']]))});")
    used = 0
    for i, b in enumerate(batches, 1):
        ids = [p["pmcid"] for p in b]
        spot = None
        if i % SPOT_EVERY == 1 and used < len(spot_cycle):
            # one hidden known-answer paper, at a random place in the batch
            spot = spot_cycle[used]["pmcid"]
            used += 1
            ids.insert(rng.randrange(len(ids) + 1), spot)
        out.append("INSERT INTO dq_batches (id, round, seq, papers_json, spot_pmcid) VALUES "
                   f"({q(f'dqb_{rnd.lower()}_{i:05d}')}, {q(rnd)}, {i}, {q(json.dumps(ids))}, {q(spot)});")
    open(a.out, "w").write("\n".join(out) + "\n")
    print(f"{len(pool)} papers, {len(batches)} batches, {used} spot checks placed -> {a.out}")


if __name__ == "__main__":
    main()
