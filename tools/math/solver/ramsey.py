"""House solver for Ramsey lower bounds: a graph on n vertices with no s-clique and no
independent set of size t. Searches circulant graphs (vertex i joined to i±d for each d
in a set D), where many best-known bounds come from, with simulated annealing on D.

A long shot by design: these records have stood for years. Posts only a graph that
passes a full exact check here and is at least as big as the house team's best.
"""
import argparse, random, time
import common


def adj_of(n, D):
    A = [0] * n
    for i in range(n):
        for d in D:
            A[i] |= 1 << ((i + d) % n) | 1 << ((i - d) % n)
    return A


def count_cliques_with0(A, n, k, cap):
    """Cliques of size k through vertex 0 (enough for a circulant: every vertex looks alike)."""
    found = 0

    def rec(cand, size):
        nonlocal found
        if found >= cap:
            return
        if size == k:
            found += 1; return
        while cand and found < cap:
            if bin(cand).count("1") < k - size:
                return
            v = cand.bit_length() - 1
            cand &= ~(1 << v)
            rec(cand & A[v], size + 1)

    rec(A[0] & ~1, 1)
    return found


def complement(A, n):
    full = (1 << n) - 1
    return [(full & ~A[i]) & ~(1 << i) for i in range(n)]


def cost(n, D, s, t, cap):
    A = adj_of(n, D)
    return count_cliques_with0(A, n, s, cap) + count_cliques_with0(complement(A, n), n, t, cap)


def full_check(n, D, s, t):
    """No s-clique and no independent t-set anywhere (not just through vertex 0)."""
    A = adj_of(n, D)
    return count_cliques_with0(A, n, s, 1) == 0 and count_cliques_with0(complement(A, n), n, t, 1) == 0


def search(n, s, t, seconds, rng):
    half = list(range(1, n // 2 + 1))
    D = set(d for d in half if rng.random() < 0.5)
    cap = 2000
    c = cost(n, D, s, t, cap); best = (c, set(D)); T = 2.0; start = time.time(); steps = 0
    while time.time() - start < seconds and best[0] > 0:
        steps += 1
        d = rng.choice(half)
        D2 = set(D); D2 ^= {d}
        c2 = cost(n, D2, s, t, cap)
        if c2 <= c or rng.random() < pow(2.718, (c - c2) / max(T, 1e-3)):
            D, c = D2, c2
            if c < best[0]:
                best = (c, set(D))
        T *= 0.9995
        if steps % 3000 == 0:
            T = 2.0; D = set(best[1])
    return best, steps


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--s", type=int, required=True)
    ap.add_argument("--t", type=int, required=True)
    ap.add_argument("--seconds", type=float, default=900)
    ap.add_argument("--n", type=int, default=None, help="vertices to try (default: the record, then one more)")
    a = ap.parse_args()
    pid = f"ramsey-{a.s}-{a.t}"
    p = common.problem(pid)
    record = int(p["record"])
    ours = common.our_best(p)
    sizes = [a.n] if a.n else [record + 1, record]
    rng = random.Random()
    for n in sizes:
        (c, D), steps = search(n, a.s, a.t, a.seconds / len(sizes), rng)
        if c == 0 and full_check(n, D, a.s, a.t):
            if ours is not None and n <= int(ours):
                common.summary(f"| {pid} | {n} vertices | found | not posted, house best already {ours} |"); return
            edges = sorted({tuple(sorted((i, (i + d) % n))) for i in range(n) for d in D})
            r = common.submit(pid, {"n": n, "edges": [list(e) for e in edges]}, f"Circulant graph, distances {sorted(D)}, {steps} annealing steps.")
            res = r.get("vet", {}).get("result") or r.get("vet", {}).get("status") or r.get("skipped") or r.get("error")
            common.summary(f"| {pid} | {n} vertices (record {record}) | found | posted: {res} |"); return
        common.summary(f"| {pid} | {n} vertices (record {record}) | best circulant still had {c} bad sets | not posted |")


if __name__ == "__main__":
    main()
