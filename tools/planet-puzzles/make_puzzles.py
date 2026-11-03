#!/usr/bin/env python3
"""Build a season of planet-hunting puzzles from real NASA TESS light curves.

Hidden puzzles: a real 2-minute SPOC light curve of a star where NASA's
pipeline found NO transit signal (no data-validation file), binned to 20
minutes, with a secret synthetic transit injected into most of them and
nothing added to the rest. The star's identity and the injection are written
ONLY to the private answers file, which must never be committed: the scoring
key lives in the production database.

Practice puzzles: real light curves of stars where NASA's pipeline DID find a
signal (a threshold crossing event). Their answers are public at MAST anyway,
so they are worth little and are shown after a submission.

Data: s3://stpubdata/tess/public (AWS Open Data, no account needed).

  python3 make_puzzles.py --sector 90 --hidden 30 --practice 6 \
      --out ../../src/science/planet-puzzles.ts --answers /somewhere/private/answers.json
"""
import argparse, io, json, random, re, sys, urllib.request
import numpy as np
from astropy.io import fits

S3 = "https://s3.amazonaws.com/stpubdata"
BIN_MIN = 20

def http(url):
    with urllib.request.urlopen(url, timeout=120) as r:
        return r.read()

def list_keys(prefix, start_after=None, max_keys=1000):
    q = f"{S3}/?list-type=2&prefix={prefix}&max-keys={max_keys}"
    if start_after:
        q += f"&start-after={start_after}"
    xml = http(q).decode()
    return re.findall(r"<Key>([^<]+)</Key>", xml)

def prefixes(prefix):
    xml = http(f"{S3}/?list-type=2&prefix={prefix}&delimiter=/&max-keys=1000").decode()
    return re.findall(r"<Prefix>([^<]+/)</Prefix>", xml)[1:] if False else [p for p in re.findall(r"<Prefix>([^<]+/)</Prefix>", xml) if p != prefix]

def star_folders(sector, rng, want=400):
    """Map star folder -> {lc, dvt}, sampled from random branches of the sector listing."""
    out = {}
    base = f"tess/public/tid/s{sector:04d}/"
    level2 = [q for p1 in prefixes(base) for q in prefixes(p1)]
    tries = 0
    while len(out) < want and tries < 40:
        tries += 1
        branch = rng.choice(level2)
        for k in list_keys(branch):
            folder = k.rsplit("/", 1)[0]
            d = out.setdefault(folder, {})
            if k.endswith("-s_lc.fits"):
                d["lc"] = k
            elif "_dvt.fits" in k:
                d["dvt"] = k
    return {f: d for f, d in out.items() if "lc" in d}

def load_lc(key):
    h = fits.open(io.BytesIO(http(f"{S3}/{key}")))
    hd = h[0].header
    d = h[1].data
    t, f, q = np.array(d["TIME"], float), np.array(d["PDCSAP_FLUX"], float), np.array(d["QUALITY"])
    ok = np.isfinite(t) & np.isfinite(f) & (q == 0)
    t, f = t[ok], f[ok]
    if len(t) < 5000:
        return None
    f = f / np.median(f) - 1.0
    return {"tic": int(hd["TICID"]), "sector": int(hd["SECTOR"]), "tmag": float(hd.get("TESSMAG", 0) or 0), "t": t, "f": f}

def bin_lc(t, f, t_start):
    keep = t >= t_start
    t, f = t[keep], f[keep]
    edges = np.arange(t_start, t.max() + BIN_MIN / 1440, BIN_MIN / 1440)
    idx = np.digitize(t, edges) - 1
    n = len(edges) - 1
    s = np.bincount(idx, f, minlength=n + 1)[:n]
    c = np.bincount(idx, minlength=n + 1)[:n]
    flux = np.where(c >= 5, s / np.maximum(c, 1), np.nan)
    return flux  # bin i covers [t_start + i*bin, +bin); its time is the bin centre

def noise(flux):
    x = flux[np.isfinite(flux)]
    d = np.diff(x)
    return float(1.4826 * np.median(np.abs(d - np.median(d))) / np.sqrt(2))

def trapezoid(tt, period, t0, depth, dur_d, ingress_frac):
    ph = ((tt - t0 + period / 2) % period) - period / 2
    a = np.abs(ph)
    full = dur_d / 2 * (1 - ingress_frac)
    edge = dur_d / 2
    m = np.zeros_like(tt)
    m[a <= full] = depth
    ramp = (a > full) & (a < edge)
    m[ramp] = depth * (edge - a[ramp]) / (edge - full)
    return -m

def tce(key):
    h = fits.open(io.BytesIO(http(f"{S3}/{key}")))
    x = h[1].header
    return {"period": float(x["TPERIOD"]), "epoch_btjd": float(x["TEPOCH"]), "depth_ppm": float(x["TDEPTH"]), "duration_hours": float(x["TDUR"])}

def encode(flux_rel):
    return [None if not np.isfinite(v) else int(round(v * 1e6)) for v in flux_rel]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sector", type=int, default=90)
    ap.add_argument("--hidden", type=int, default=30)
    ap.add_argument("--practice", type=int, default=6)
    ap.add_argument("--empty-frac", type=float, default=0.25)
    ap.add_argument("--season", default="S1")
    ap.add_argument("--out", required=True)
    ap.add_argument("--answers", required=True)
    ap.add_argument("--seed", type=int, default=None)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    nrng = np.random.default_rng(rng.randrange(2**32))

    folders = star_folders(a.sector, rng)
    quiet = [d["lc"] for d in folders.values() if "dvt" not in d]
    signal = [d for d in folders.values() if "dvt" in d]
    rng.shuffle(quiet); rng.shuffle(signal)
    print(f"{len(folders)} stars listed: {len(quiet)} without a pipeline signal, {len(signal)} with one", file=sys.stderr)

    puzzles, answers = [], []
    n_empty = round(a.hidden * a.empty_frac)
    plan = ["empty"] * n_empty + ["planet"] * (a.hidden - n_empty)
    rng.shuffle(plan)
    hi = 0
    for key in quiet:
        if hi >= a.hidden:
            break
        lc = load_lc(key)
        if not lc:
            continue
        # Crop a random few hours off each end so the window does not line up with the archive file.
        t0s = lc["t"].min() + rng.uniform(0, 0.4)
        flux = bin_lc(lc["t"], lc["f"], t0s)
        sig = noise(flux)
        if not (80e-6 < sig < 3000e-6):
            continue  # too noisy to be fair, or saturated-looking
        n = len(flux)
        tt = t0s + (np.arange(n) + 0.5) * BIN_MIN / 1440
        span = tt[-1] - tt[0]
        pid = f"pz_{a.season.lower()}_{hi + 1:02d}"
        ans = {"puzzle_id": pid, "source_tic": lc["tic"], "source_sector": lc["sector"], "has_planet": plan[hi] == "planet"}
        if plan[hi] == "planet":
            period = float(np.exp(rng.uniform(np.log(0.8), np.log(min(12.0, span / 2.2)))))
            dur_h = 13 * (period / 365.25) ** (1 / 3) * rng.uniform(0.6, 1.25)
            dur_d = dur_h / 24
            t0 = tt[0] + rng.uniform(0.1, 0.9) * period
            n_tr = int((tt[-1] - t0) // period) + 1
            pts_in = max(1.0, n_tr * dur_d * 1440 / BIN_MIN * 0.85)
            snr = rng.uniform(8, 28)
            depth = snr * sig / np.sqrt(pts_in)
            ing = rng.uniform(0.1, 0.3)
            flux = flux + trapezoid(tt, period, t0, depth, dur_d, ing)
            ans.update({"period_days": period, "t0_days": float(t0 - tt[0] + 0.5 * BIN_MIN / 1440), "depth_ppm": float(depth * 1e6),
                        "duration_hours": float(dur_h), "snr": float(snr), "transits": n_tr})
        flux = flux + nrng.normal(0, 0.15 * sig, n)  # fresh noise, so the file never equals the archive copy
        puzzles.append({"id": pid, "kind": "hidden", "label": f"Hidden star {hi + 1:02d}", "cadence_minutes": BIN_MIN,
                        "points": len(flux), "noise_ppm": round(sig * 1e6), "flux_ppm": encode(flux)})
        answers.append(ans)
        hi += 1
        print(f"  {pid} {'planet' if ans['has_planet'] else 'empty '} noise {sig*1e6:.0f} ppm", file=sys.stderr)

    pi = 0
    for d in signal:
        if pi >= a.practice:
            break
        lc = load_lc(d["lc"])
        if not lc:
            continue
        try:
            s = tce(d["dvt"])
        except Exception:
            continue
        if not (0.5 < s["period"] < 13 and s["depth_ppm"] > 300):
            continue
        t0s = lc["t"].min()
        flux = bin_lc(lc["t"], lc["f"], t0s)
        pid = f"pp_{a.season.lower()}_{pi + 1:02d}"
        first = s["epoch_btjd"] + np.ceil((t0s - s["epoch_btjd"]) / s["period"]) * s["period"]
        puzzles.append({"id": pid, "kind": "practice", "label": f"Practice: TIC {lc['tic']}", "tic_id": lc["tic"], "sector": lc["sector"],
                        "cadence_minutes": BIN_MIN, "points": len(flux), "noise_ppm": round(noise(flux) * 1e6), "flux_ppm": encode(flux),
                        "answer": {"source": "NASA TESS pipeline (SPOC) threshold crossing event", "period_days": round(s["period"], 6),
                                   "t0_days": round(float(first - t0s), 5), "depth_ppm": round(s["depth_ppm"]), "duration_hours": round(s["duration_hours"], 3)}})
        pi += 1
        print(f"  {pid} TIC {lc['tic']} P={s['period']:.3f}", file=sys.stderr)

    meta = {"season": a.season, "source": f"NASA TESS sector {a.sector}, SPOC 2-minute light curves (AWS Open Data stpubdata), binned to {BIN_MIN} minutes",
            "time": "time_days = (i + 0.5) * cadence_minutes / 1440 for point i; t0 is in the same days-from-start scale",
            "flux": "flux_ppm = brightness relative to the star's median, parts per million; null = no good data in that bin",
            "puzzles": puzzles}
    with open(a.out, "w") as fh:
        body = json.dumps(meta, separators=(",", ":"))
        if a.out.endswith(".ts"):
            fh.write("// Generated by tools/planet-puzzles/make_puzzles.py from NASA TESS data. Do not edit by hand.\n"
                     "// Light curves only: the answer key is NOT here (it lives in the production database).\n"
                     "import type { PlanetSeason } from \"./planets.js\";\n"
                     f"export const SEASON: PlanetSeason = {body};\n")
        else:
            fh.write(body)
    with open(a.answers, "w") as fh:
        json.dump(answers, fh, indent=1)
    print(f"wrote {len(puzzles)} puzzles", file=sys.stderr)

if __name__ == "__main__":
    main()
