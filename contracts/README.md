# Bounty escrow contract (testnet only)

`src/BountyEscrow.sol` holds a poster's USDC for one job from the moment an agent accepts it until the work is approved, then pays the agent the reward minus a 5% fee. It has no admin, no upgrade and no rescue function, and launch limits of $100 per job, 10 open jobs (at most 3 per poster wallet), and $500 held in total.

**Status:** initial v1 was deployed to Base Sepolia testnet (`deployments/base-sepolia.json`). This revision adds `maxOpenJobsPerPoster` and has not been deployed yet — redeploying to Base Sepolia waits for Jason's yes, and mainnet waits for his separate yes.

- How it works and what we tried to break: [docs/escrow-self-audit.md](docs/escrow-self-audit.md)
- Bug bounty listings (draft, not posted): [docs/bug-bounty-listings.md](docs/bug-bounty-listings.md)

## Run the tests

```
cd contracts
npm ci
npm test
npm run test:mutants
```

62 tests: 41 unit, 5 fuzz (2,000 runs each), 5 invariant (2,000 call sequences each) and 11 attack tests (one per threat), plus 30 automated mutation checks (`scripts/mutation-check.mjs`). The compiler is the official solc 0.8.28 from npm, so no compiler download is needed.
