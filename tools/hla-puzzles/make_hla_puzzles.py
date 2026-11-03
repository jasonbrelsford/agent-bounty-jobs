#!/usr/bin/env python3
"""Generate HLA lab-report cleanup puzzles for bounty's open science challenges.

Each puzzle is a SYNTHETIC typing report (no real person) for five loci, two alleles each,
written the messy way real reports are: old colon-less names, the old Cw label, names the
IPD-IMGT/HLA database later renamed or deleted, scanner (OCR) misreads, odd separators, a dash
for a homozygous second allele, names cut off at the end of a line, and a few names that were
never assigned.

Answer for each slot, in the order written:
  - the CURRENT 2-field name in IPD-IMGT/HLA 3.66.0 (rules of normalize.py: deleted names follow
    their successor, legacy names convert, the expression suffix stays only if every allele under
    the 2-field name carries it);
  - a "/"-joined list of every current 2-field name the cut-off text could be, when it cannot be
    pinned down;
  - INVALID when the text was never an assigned name.

Writes:
  --out       the public season module (.ts): reports and slots, answers only for practice reports
  --answers   the private answer key (JSON) for hidden reports. Never commit it.

Usage: python3 -I make_hla_puzzles.py --imgt-cache DIR --hidden 24 --practice 4 --out X.ts --answers Y.json
Needs imgt.py and normalize.py (Apache-2.0, from jasonbrelsford/verifiable-science-envs) next to it.
"""
from __future__ import annotations

import argparse
import json
import random
import re
import secrets
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from imgt import ImgtReference, split_allele  # noqa: E402
from normalize import normalize  # noqa: E402

TAG = "v3.66.0-alpha"
LOCI = ["A", "B", "C", "DRB1", "DQB1"]
POINTS = {"correct": 1, "wrong": -1, "unsure": 0, "overlap": 0}


def two_field(ref, s):
    r = normalize(ref, s)
    return None if r["allele_2field"] == "UNRESOLVABLE" else r["allele_2field"]


def pool(ref):
    """True alleles to draw from: plain 2-field names with 2-digit fields, assigned by 2009, not null."""
    out = {}
    for L in LOCI:
        names, seen = set(), set()
        for a in ref.alleles(L):
            loc, f, suf = split_allele(a)
            if len(f) < 2 or len(f[0]) != 2 or len(f[1]) != 2 or int(f[1]) > 40:
                continue
            base = f"{loc}*{f[0]}:{f[1]}"
            if base in names or base in seen:
                continue
            seen.add(base)
            if not any(ref.name_at(ref.hla_id(m), "2.25.0") for m in ref.expand(base)):
                continue  # not yet assigned in 2009, so it has no honest colon-less form
            t = two_field(ref, base)
            if t != base:  # skip anything whose 2-field name carries a suffix or renames
                continue
            names.add(base)
        out[L] = sorted(names)
    return out


def deleted_pool(ref):
    """Deleted / renamed names whose successor is a valid, different 2-field name, by locus."""
    out = {L: [] for L in LOCI}
    for name, d in ref.deleted.items():
        try:
            loc = name.split("*")[0]
        except Exception:
            continue
        loc = "C" if loc == "Cw" else loc
        if loc not in out:
            continue
        t = two_field(ref, name)
        if not t or t.endswith(("N", "L", "Q", "S", "C", "A")):
            continue
        loc2, f, _ = split_allele(name) if ":" in name else (loc, [name.split("*")[1][:2], name.split("*")[1][2:4]], "")
        if f"{loc}*{f[0]}:{f[1]}" == t:
            continue  # not really a rename at 2 fields
        out[loc].append((name, t))
    return out


def legacy(name):
    loc, f, suf = split_allele(name)
    loc = "Cw" if loc == "C" else loc
    return f"{loc}*{''.join(f)}{suf}"


OCR = {"0": "O", "1": "l", "5": "S", "8": "B"}


def ocr(text, rng):
    star = text.index("*")
    idx = [i for i, ch in enumerate(text) if i > star and ch in OCR]
    if not idx:
        return None
    k = rng.choice(idx)
    out = text[:k] + OCR[text[k]] + text[k + 1:]
    if rng.random() < 0.3 and len(idx) > 1:
        k2 = rng.choice([i for i in idx if i != k])
        out = out[:k2] + OCR[out[k2]] + out[k2 + 1:]
    return out


def separator(name, rng):
    loc, f, _ = split_allele(name)
    sep = rng.choice([".", "-", " ", ";"])
    head = rng.choice([f"{loc}*", f"{loc} ", f"HLA-{loc} "])
    return head + sep.join(f[:2])


def truncated(ref, name):
    """Cut the last digit off a 2-field name; ambiguous if 2 to 8 current names could follow."""
    loc, f, _ = split_allele(name)
    if not f[1].startswith("0"):
        return None  # only cut "x:0_" so exactly one digit can be missing (no 3-digit field starts with 0)
    stem = f"{loc}*{f[0]}:{f[1][:-1]}"
    cands = set()
    for d in "0123456789":
        for extra in ("", ):
            c = f"{stem}{d}{extra}"
            t = two_field(ref, c)
            if t and t.split("*")[1].split(":")[1].rstrip("NLQSCA") == f"{f[1][:-1]}{d}":
                cands.add(t)
    if 2 <= len(cands) <= 10 and name in cands:
        return stem, sorted(cands, key=lambda x: (len(x), x))
    return None


def never_assigned(ref, L, rng):
    firsts = sorted({x.split("*")[1].split(":")[0] for x in ref.alleles(L) if ":" in x})
    for i in range(4000):
        first = rng.choice(firsts)
        sec = f"{rng.randint(10, 99):02d}" if i < 2000 else f"{rng.randint(500, 999)}"
        c = f"{L}*{first}:{sec}"
        if two_field(ref, c) is None and not ref.expand(c) and not ref.is_deleted(c):
            return c
    raise RuntimeError("no fake name found")


STYLES = {
    "1998": "1998 lab system export (old colon-less names)",
    "2008": "2008 report received by fax and scanned (text read by OCR)",
    "2016": "2016 lab system report (colon names)",
    "sheet": "Spreadsheet someone typed by hand",
}


def write_clean(name, style):
    if style in ("1998", "2008"):
        return legacy(name)
    return name


def make_report(ref, P, D, rng, idx):
    style = rng.choice(list(STYLES))
    slots, answers, kinds = [], [], []
    for L in LOCI:
        pair = []
        for j in (0, 1):
            # weights: mechanical (clean, renamed, invalid) vs reading (ocr, separator, homozygous, cut-off)
            options = ["clean", "clean", "renamed", "invalid", "ocr", "separator", "cutoff"]
            if j == 1:
                options += ["homozygous", "homozygous"]
            if style == "2008":
                options += ["ocr", "ocr"]
            if style == "sheet":
                options += ["separator", "separator"]
            for _ in range(50):
                kind = rng.choice(options)
                true = rng.choices(P[L], weights=[1 / int(x.split(":")[1]) ** 1.5 for x in P[L]])[0]
                if kind == "clean":
                    text, ans = write_clean(true, style), true
                elif kind == "renamed":
                    if not D[L]:
                        continue
                    text, ans = rng.choice(D[L])
                elif kind == "invalid":
                    fake = never_assigned(ref, L, rng)
                    if style in ("1998", "2008") and len(fake.split(":")[1]) != 2:
                        continue
                    text, ans = write_clean(fake, style), "INVALID"
                elif kind == "ocr":
                    base = write_clean(true, style)
                    text = ocr(base, rng)
                    if not text or two_field(ref, text) is not None:
                        continue
                    ans = true
                elif kind == "separator":
                    text, ans = separator(true, rng), true
                    if two_field(ref, text) is not None:
                        continue
                elif kind == "cutoff":
                    tr = truncated(ref, true)
                    if not tr:
                        continue
                    stem = tr[0]
                    if style in ("1998", "2008"):
                        loc0, rest = stem.split("*")
                        stem = f"{'Cw' if loc0 == 'C' else loc0}*{rest.replace(':', '')}"
                    text, ans = stem, "/".join(tr[1])
                elif kind == "homozygous":
                    text = rng.choice(["-", "–", "blank", "hom.", "(homozygous)", "same"])
                    ans = answers[-1]
                    if ans == "INVALID" or "/" in ans:
                        continue
                break
            else:
                raise RuntimeError("slot generation failed")
            pair.append(text)
            answers.append(ans)
            kinds.append(kind)
        slots.append((L, pair))
    label_loc = {"C": "Cw" if style in ("1998", "2008") else "C"}
    w = max(len(t) for _, p in slots for t in p) + 3
    lines = [f"SYNTHETIC REPORT {idx:02d}  (made up for this game: not a real person)",
             f"Source: {STYLES[style]}", "", f"{'Locus':<10}{'Allele 1':<{w}}Allele 2"]
    for L, (a, b) in slots:
        lines.append(f"{'HLA-' + label_loc.get(L, L) if style != 'sheet' else label_loc.get(L, L):<10}{a:<{w}}{b}")
    return {"style": style, "text": "\n".join(lines), "slots": [f"{L}.{j+1}" for L in LOCI for j in (0, 1)],
            "written": [t for _, p in slots for t in p]}, answers, kinds


def score(key, sub):
    """Per-slot points. key and sub are lists of strings."""
    total = 0
    for k, s in zip(key, sub):
        s = (s or "").strip()
        if s.upper() == "UNSURE" or not s:
            continue
        if "/" in k:
            want = set(k.split("/"))
            got = set(x.strip() for x in s.split("/"))
            total += 1 if got == want else (0 if len(got) > 1 and got & want else -1)
        elif k == "INVALID":
            total += 1 if s.upper() == "INVALID" else -1
        else:
            total += 1 if s == k else -1
    return total


def baseline_answer(ref, written, slot, rejected="INVALID"):
    """A name checker used as written: each text through normalize; what it rejects -> `rejected`."""
    loc = slot.split(".")[0]
    t = written.strip()
    if "*" not in t and re.fullmatch(r"\d[\d:]*", t):
        t = f"{loc}*{t}"
    r = two_field(ref, t)
    return r or rejected


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--imgt-cache", default="./cache")
    ap.add_argument("--hidden", type=int, default=24)
    ap.add_argument("--practice", type=int, default=4)
    ap.add_argument("--out", required=True)
    ap.add_argument("--answers", required=True)
    ap.add_argument("--seed", type=int, default=None, help="leave unset for a secret random seed")
    a = ap.parse_args()
    seed = a.seed if a.seed is not None else secrets.randbits(64)
    rng = random.Random(seed)
    ref = ImgtReference.load(tag=TAG, cache_dir=a.imgt_cache)
    P, D = pool(ref), deleted_pool(ref)
    print({L: len(P[L]) for L in LOCI}, {L: len(D[L]) for L in LOCI}, file=sys.stderr)

    puzzles, key, kinds_all, base_total, base2_total, max_total = [], {}, {}, 0, 0, 0
    n = 0
    for kind, count in (("hidden", a.hidden), ("practice", a.practice)):
        for i in range(count):
            n += 1
            rep, ans, kinds = make_report(ref, P, D, rng, n)
            pid = f"hz_h1_{i+1:02d}" if kind == "hidden" else f"hp_h1_{i+1:02d}"
            item = {"id": pid, "kind": kind, "label": f"Report {pid[-2:]}" if kind == "hidden" else f"Practice report {pid[-2:]}",
                    "style": rep["style"], "text": rep["text"], "slots": rep["slots"], "written": rep["written"]}
            b = [baseline_answer(ref, w, s) for w, s in zip(rep["written"], rep["slots"])]
            b2 = [baseline_answer(ref, w, s, "UNSURE") for w, s in zip(rep["written"], rep["slots"])]
            if kind == "hidden":
                key[pid] = ans
                kinds_all[pid] = kinds
                base_total += score(ans, b)
                base2_total += score(ans, b2)
                max_total += len(ans)
            else:
                item["answer"] = ans
                item["kinds"] = kinds
            puzzles.append(item)

    season = {
        "season": "H1",
        "release": "3.66.0",
        "release_tag": TAG,
        "source": "Answers follow IPD-IMGT/HLA release 3.66.0 (git tag v3.66.0-alpha of github.com/ANHIG/IMGTHLA)",
        "baseline": max(
            {"points": base_total, "max": max_total,
             "how": "every name run through a name checker exactly as written, anything it rejects marked INVALID"},
            {"points": base2_total, "max": max_total,
             "how": "every name run through a name checker exactly as written, anything it rejects left UNSURE"},
            key=lambda x: x["points"]),
        "puzzles": puzzles,
    }
    Path(a.out).write_text(
        "// Generated by tools/hla-puzzles/make_hla_puzzles.py. Do not edit by hand.\n"
        "// Hidden answers are NOT in this file: they live only in the sci_hla_answers table.\n"
        'import type { HlaSeason } from "./hla.js";\n'
        f"export const HLA_SEASON: HlaSeason = {json.dumps(season, indent=1)};\n")
    Path(a.answers).write_text(json.dumps({"seed": seed, "key": key, "kinds": kinds_all}, indent=1))
    print(f"baseline invalid-policy {base_total}/{max_total}, unsure-policy {base2_total}/{max_total}", file=sys.stderr)


if __name__ == "__main__":
    main()
