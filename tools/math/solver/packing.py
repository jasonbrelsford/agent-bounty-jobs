"""House solver for circle packing: n circles in the unit square, largest total radius.

Random starts plus basin hopping with SLSQP, seeded from last night's best (kept in a
cache dir), then made exactly feasible in decimals and checked with fractions the way
the site checks it. Posts only when it beats the house team's own best on the site.
"""
import argparse, json, os, time
from decimal import Decimal, getcontext
from fractions import Fraction
import numpy as np
from scipy.optimize import minimize
import common

getcontext().prec = 60


def make_runner(n):
    iu = np.triu_indices(n, 1)
    m = len(iu[0])

    def cons(v):
        x, y, r = v[:n], v[n:2 * n], v[2 * n:]
        d = np.hypot(x[iu[0]] - x[iu[1]], y[iu[0]] - y[iu[1]])
        return np.r_[x - r, 1 - x - r, y - r, 1 - y - r, d - r[iu[0]] - r[iu[1]]]

    def jac(v):
        x, y, r = v[:n], v[n:2 * n], v[2 * n:]
        J = np.zeros((4 * n + m, 3 * n)); I = np.arange(n)
        J[I, I] = 1; J[I, 2 * n + I] = -1
        J[n + I, I] = -1; J[n + I, 2 * n + I] = -1
        J[2 * n + I, n + I] = 1; J[2 * n + I, 2 * n + I] = -1
        J[3 * n + I, n + I] = -1; J[3 * n + I, 2 * n + I] = -1
        dx = x[iu[0]] - x[iu[1]]; dy = y[iu[0]] - y[iu[1]]; d = np.hypot(dx, dy) + 1e-18; k = 4 * n + np.arange(m)
        J[k, iu[0]] = dx / d; J[k, iu[1]] = -dx / d; J[k, n + iu[0]] = dy / d; J[k, n + iu[1]] = -dy / d
        J[k, 2 * n + iu[0]] = -1; J[k, 2 * n + iu[1]] = -1
        return J

    g = np.zeros(3 * n); g[2 * n:] = -1

    def run(v):
        res = minimize(lambda v: -v[2 * n:].sum(), v, jac=lambda v: g, method="SLSQP",
                       constraints=[{"type": "ineq", "fun": cons, "jac": jac}],
                       bounds=[(0, 1)] * (2 * n) + [(0, 0.5)] * n, options={"maxiter": 3000, "ftol": 1e-16})
        return (res.x[2 * n:].sum() if cons(res.x).min() > -1e-10 else 0.0), res.x

    return run


def exact_ok(circles):
    """The site's check, in fractions: inside the square and no overlaps."""
    F = [[Fraction(a) for a in c] for c in circles]
    for x, y, r in F:
        if r <= 0 or x - r < 0 or x + r > 1 or y - r < 0 or y + r > 1:
            return False
    for i in range(len(F)):
        for j in range(i + 1, len(F)):
            dx, dy, rr = F[i][0] - F[j][0], F[i][1] - F[j][1], F[i][2] + F[j][2]
            if dx * dx + dy * dy < rr * rr:
                return False
    return True


def exactify(v, n):
    """Decimal strings that pass the exact check, shrinking each radius only by the overlap it
    actually has (computed in 50-digit decimals), so the total loses as little as possible."""
    q = Decimal(10) ** -30
    X = [Decimal(repr(float(t))).quantize(q) for t in v[:n]]
    Y = [Decimal(repr(float(t))).quantize(q) for t in v[n:2 * n]]
    R = [Decimal(repr(float(t))).quantize(q) for t in v[2 * n:]]
    tiny = Decimal(10) ** -28
    for _ in range(50):
        for i in range(n):
            R[i] = min(R[i], X[i], 1 - X[i], Y[i], 1 - Y[i])
        changed = False
        for i in range(n):
            for j in range(i + 1, n):
                d = ((X[i] - X[j]) ** 2 + (Y[i] - Y[j]) ** 2).sqrt()
                over = R[i] + R[j] - d
                if over > 0:
                    cut = over / 2 + tiny
                    R[i] -= cut; R[j] -= cut; changed = True
        R = [r.quantize(q, rounding="ROUND_FLOOR") for r in R]
        circles = [[str(X[i]), str(Y[i]), str(R[i])] for i in range(n)]
        if not changed and exact_ok(circles):
            return circles, sum(R)
        if exact_ok(circles):
            return circles, sum(R)
    return None, Decimal(0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, required=True)
    ap.add_argument("--seconds", type=float, default=900)
    ap.add_argument("--cache", default=".math-cache")
    ap.add_argument("--seed", type=int, default=None)
    a = ap.parse_args()
    n, pid = a.n, f"packing-{a.n}"
    os.makedirs(a.cache, exist_ok=True)
    cpath = os.path.join(a.cache, f"{pid}.json")
    rng = np.random.default_rng(a.seed if a.seed is not None else int(time.time()) % 2**32)
    run = make_runner(n)
    best, bv = 0.0, None
    if os.path.exists(cpath):
        try:
            seed = np.array(json.load(open(cpath))["v"], dtype=float)
            best, bv = run(seed)
        except Exception:
            pass
    t, tries = time.time(), 0
    while time.time() - t < a.seconds:
        tries += 1
        if bv is None or rng.random() < 0.25:
            v = np.r_[rng.random(2 * n), np.full(n, 0.02)]
        else:
            v = bv.copy(); k = int(rng.integers(1, min(4, n + 1))); idx = rng.choice(n, k, replace=False)
            v[idx] = rng.random(k); v[n + idx] = rng.random(k); v[2 * n + idx] = 0.01
            v[:2 * n] += rng.normal(0, 0.01 * rng.random(), 2 * n); v = np.clip(v, 0, 1)
        s, x = run(v)
        if s > best:
            best, bv = s, x
    if bv is None:
        common.summary(f"| {pid} | no feasible packing found | | |"); return
    json.dump({"v": bv.tolist(), "sum": best}, open(cpath, "w"))
    circles, value = exactify(bv, n)
    p = common.problem(pid)
    record, ours = Decimal(p["record"]), common.our_best(p)
    gap = record - value
    if circles is None:
        common.summary(f"| {pid} | {best:.12f} | could not make it exact | |"); return
    if ours is not None and value <= Decimal(ours) + Decimal("1e-13"):
        common.summary(f"| {pid} | {value:.12f} | {gap:.2e} below the record | not posted, house best already {Decimal(ours):.12f} |"); return
    r = common.submit(pid, {"circles": circles}, f"{tries} local searches in {a.seconds:.0f}s.")
    res = r.get("vet", {}).get("result") or r.get("vet", {}).get("status") or r.get("skipped") or r.get("error")
    common.summary(f"| {pid} | {value:.12f} | {gap:.2e} below the record | posted: {res} |")
    if "error" in r:
        print(json.dumps(r)[:800])


if __name__ == "__main__":
    main()
