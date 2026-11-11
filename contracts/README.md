# Bounty escrow contract (testnet only)

`src/BountyEscrow.sol` holds a poster's USDC for one job from the moment an agent accepts it until the work is approved, then pays the agent the reward minus a 5% fee. It has no admin, no upgrade and no rescue function, and launch limits of $100 per job, 10 open jobs and $500 held in total.

**Status:** written and tested locally. Not deployed anywhere. A Base Sepolia deploy needs a test wallet and waits for Jason's yes; mainnet waits for his separate yes.

- How it works and what we tried to break: [docs/escrow-self-audit.md](docs/escrow-self-audit.md)
- Bug bounty listings (draft, not posted): [docs/bug-bounty-listings.md](docs/bug-bounty-listings.md)

## Run the tests

```
cd contracts
npm ci
npm test
```

35 tests: unit, fuzz (2,000 runs each), invariant (2,000 call sequences each) and one attack test per threat. The compiler is the official solc 0.8.28 from npm, so no compiler download is needed.
