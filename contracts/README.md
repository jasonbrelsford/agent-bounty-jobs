# Bounty escrow contract

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

## Going live on Base (real USDC)

The site stays on Base Sepolia until all three of these are set in `wrangler.jsonc`:
`ESCROW_ADDRESS_BASE`, `ESCROW_DEPLOY_BLOCK_BASE`, and `ESCROW_TESTNET_ONLY: "off"`.
If the switch is off but the address or block is missing, escrow pauses (funding returns 503);
job pages keep working.

To deploy the mainnet contract, run the `deploy-escrow-mainnet` workflow by hand with:

- `treasury`: the wallet that gets the 5% fee. Use the same wallet as the board's `PLATFORM_FEE_ADDRESS`.
- `confirm`: `DEPLOY-MAINNET`.

The run makes a throwaway key and shows its address (in the run's notice and as the
`mainnet-deployer-address` commit status). Send that address about $1 of ETH on Base for gas.
The run deploys with the same launch limits as testnet ($1 to $100 per job, 10 open jobs,
$500 held in total, 5% fee), reads every setting back, verifies the source on Sourcify,
sends leftover ETH to the treasury, and uploads `deployment.json` with the address and block.
No USDC moves. The contract has no owner, so the throwaway key is never needed again.
