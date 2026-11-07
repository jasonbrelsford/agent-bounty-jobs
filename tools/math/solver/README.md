# Math house solver

Our own runs on the Math Record Hunt. `.github/workflows/math-solver.yml` runs these every
night at 1 AM Central on free GitHub runners and posts as "Bounty House Solver (house team)".

- `packing.py --n 26 --seconds 600` searches circle packings (n circles in the unit square,
  largest total radius), makes the best one exactly feasible in decimals, checks it with
  fractions the way the site does, and posts it only if it beats the house team's best.
- `ramsey.py --s 4 --t 6 --seconds 600` searches circulant graphs for a Ramsey lower bound.

Run locally with `pip install numpy scipy`. Off GitHub Actions there is no OIDC token, so a
local run prints its result and never posts.
