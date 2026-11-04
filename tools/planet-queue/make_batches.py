#!/usr/bin/env python3
"""Build job batches for the planet-hunting queue from one TESS sector.

Every star with a 2-minute SPOC light curve in the sector becomes a job item.
Stars where NASA's pipeline found NO signal (no data-validation file) are the
search stars. Stars where it found one clean, strong signal become secret spot
checks: one is mixed into about every third batch, and an agent that misses it
is probably broken. Which stars are spot checks, and their answers, go ONLY to
the private SQL file, which is loaded straight into the queue database and must
never be committed.

Data: s3://stpubdata/tess/public (AWS Open Data, no account needed).

  python3 make_batches.py --sector 91 --round Q1 --out /somewhere/private/q1.sql
"""
import argparse, concurrent.futures as cf, json, random, re, time, urllib.request

S3 = "https://stpubdata.s3.amazonaws.com"
BATCH = 10
SPOT_EVERY = 3
SPOT_REUSE = 3

def http(url, rng=None, tries=4):
    req = urllib.request.Request(url, headers={"Range": f"bytes={rng}"} if rng else {})
    for n in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except Exception:  # dropped connections and short reads through busy networks
            if n == tries - 1:
                raise
            time.sleep(2 ** n)

def list_sector(sector):
    pre, after, keys = f"tess/public/tid/s{sector:04d}/", None, []
    while True:
        q = f"{S3}/?list-type=2&prefix={pre}&max-keys=1000" + (f"&start-after={after}" if after else "")
        x = http(q).decode()
        ks = re.findall(r"<Key>([^<]+)</Key>", x)
        keys += ks
        if "<IsTruncated>true" not in x or not ks:
            return keys
        after = ks[-1]

def tce_header(key):
    """First TCE of a data-validation file, read from its FITS header only."""
    b = http(f"{S3}/{key}", "0-100000").decode("ascii", "replace")
    cards = {}
    ext = 0
    for i in range(0, len(b), 80):
        c = b[i:i + 80]
        k = c[:8].strip()
        if k == "XTENSION":
            ext += 1
            if ext > 1:
                break
        if "=" in c[8:10]:
            v = c[10:].split("/")[0].strip().strip("'").strip()
            cards[(ext, k)] = v
    try:
        return {
            "n": int(cards[(0, "NUMTCES")]), "period": float(cards[(1, "TPERIOD")]), "epoch": float(cards[(1, "TEPOCH")]),
            "depth": float(cards[(1, "TDEPTH")]), "dur": float(cards[(1, "TDUR")]), "snr": float(cards[(1, "TSNR")]),
        }
    except (KeyError, ValueError):
        return None

def q(s):
    return "'" + str(s).replace("'", "''") + "'"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sector", type=int, required=True)
    ap.add_argument("--round", required=True)
    ap.add_argument("--seed", type=int, default=91)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    rng = random.Random(a.seed)

    keys = list_sector(a.sector)
    lc, dvt, template = set(), {}, None
    for k in keys:
        m = re.search(r"-(\d{16})-", k)
        if not m:
            continue
        tic = int(m.group(1))
        name = k.rsplit("/", 1)[1]
        if name.endswith("-s_lc.fits"):
            lc.add(tic)
            template = template or name.replace(m.group(1), "{tic16}")
        elif name.endswith("_dvt.fits"):
            dvt[tic] = k
    search = sorted(t for t in lc if t not in dvt)
    with cf.ThreadPoolExecutor(16) as ex:
        tces = dict(zip(dvt, ex.map(tce_header, dvt.values())))
    spots = [
        (t, h) for t, h in tces.items()
        if t in lc and h and h["n"] <= 2 and h["snr"] >= 12 and 500 <= h["depth"] <= 50000 and 0.4 <= h["period"] <= 13 and 0.7 <= h["dur"] <= 10
    ]
    # Each spot star is reused in up to SPOT_REUSE batches, so about every third batch carries one.
    spots = spots * SPOT_REUSE
    rng.shuffle(search)
    rng.shuffle(spots)

    batches, i, b = [], 0, 0
    while i < len(search):
        spot = spots.pop() if b % SPOT_EVERY == 0 and spots else None
        n = BATCH - (1 if spot else 0)
        stars = search[i:i + n]
        i += n
        if spot:
            stars.insert(rng.randrange(len(stars) + 1), spot[0])
        batches.append((stars, spot))
        b += 1

    rows, spot_rows = [], []
    seen = set()
    for seq, (stars, spot) in enumerate(batches, 1):
        bid = f"pqb_{a.round.lower()}_{seq:05d}"
        rows.append(f"({q(bid)}, {q(a.round)}, {a.sector}, {seq}, {q(json.dumps(stars))}, {spot[0] if spot else 'NULL'})")
        if spot and spot[0] not in seen:
            seen.add(spot[0])
            h = spot[1]
            spot_rows.append(f"({spot[0]}, {a.sector}, {h['period']:.6f}, {h['epoch']:.5f}, {h['depth']:.1f}, {h['dur']:.3f}, {h['snr']:.2f})")
    with open(a.out, "w") as f:
        f.write(f"INSERT INTO pq_rounds (id, sector, file_template, created_at) VALUES ({q(a.round)}, {a.sector}, {q(template)}, datetime('now'));\n")
        for j in range(0, len(spot_rows), 200):
            f.write("INSERT INTO pq_spot_answers (tic_id, sector, period_days, t0_btjd, depth_ppm, duration_hours, snr) VALUES\n" + ",\n".join(spot_rows[j:j + 200]) + ";\n")
        for j in range(0, len(rows), 200):
            f.write("INSERT INTO pq_batches (id, round, sector, seq, stars_json, spot_tic) VALUES\n" + ",\n".join(rows[j:j + 200]) + ";\n")
    print(json.dumps({"stars_with_lc": len(lc), "search_stars": len(search) , "pipeline_signals": len(dvt),
                      "spot_checks": len(spot_rows), "batches": len(batches), "template": template}))

if __name__ == "__main__":
    main()
