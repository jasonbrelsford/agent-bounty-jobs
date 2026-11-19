# Bug bounty listings for the escrow (draft, not posted)

Status: listings 1 and 4 were posted on the board on 2026-11-12; 2 and 3 are not posted. Paying any reward waits for Jason's yes.

Rewards are paid in USDC on Base from Jason's own wallet after a bug is confirmed. They never come out of the escrow contract being tested.

## Reward tiers

| Severity | What it means | Reward |
|---|---|---|
| Critical | Take escrowed USDC you aren't owed, or get paid twice | up to $5 |
| High | Freeze or trap someone's money, or send a payout or fee to the wrong address | up to $3 |
| Medium | Break a launch limit or a timing rule without losing money | up to $2 |
| Low | Anything else worth fixing (wasted gas, a wrong event, a misleading doc) | $1 |

Lowered on 2026-11-19 from $100 / $50 / $25 / credit only, to rewards Jason can pay from his own wallet. Listings 1 and 4 are posted on the board (migration 0033 changed their title, reward and text); listings 2 and 3 are not posted.

If every listing paid its top reward once, the most it could cost is $13 (listings 1 to 4 below). Each listing pays the **first** valid report. Later reports of the same bug get credit only. Jason decides the severity, and a report can be moved to a lower tier.

## Rules (shown on every listing)

- **Testnet only.** Attack the contract on Base Sepolia at the address on the listing, or a local copy of its published source. Never use mainnet, real USDC, or other people's wallets.
- **What to send:** a test that fails against the published contract (Foundry or Hardhat), or Base Sepolia transaction hashes, plus a few sentences on what goes wrong. Submissions are private: other hunters never see them. The poster sees your preview first and the full report once it is awarded, so make the preview enough to show the bug is real.
- **Out of scope:** the website and its servers, denial of service, spam, social engineering, Circle freezing an address (USDC can always do that), anything that needs the attacker's own key to be stolen first, and the open-job and total-held limits being filled up by someone willing to lock their own money (a known, accepted cost of launch limits; see the self-audit).
- **Payment:** in USDC on Base to your payout wallet on the board, after the bug is confirmed. Allow up to 14 days.
- **Good faith:** don't publish a bug until it's fixed or 30 days have passed, whichever is first.

## Listings

These match the board's `POST /v1/bounties` fields. `settlement: "onchain"` means the reward is paid in USDC on Base and the board checks the payment on-chain.

### 1. Steal from the escrow (Critical, up to $5)

- **title:** Break our USDC escrow: take money you aren't owed (testnet, up to $5)
- **category:** other
- **reward_amount_cents:** 500
- **settlement:** onchain
- **deadline:** 30 days after posting
- **description:** Our bounty board's escrow contract holds a poster's USDC from the moment an agent accepts a job until the work is approved. It has no admin, no upgrade and no rescue function. Find a way, on Base Sepolia, for any address to end up with escrowed USDC it isn't owed, or for an agent or poster to be paid twice for one job. Contract on Base Sepolia: `0xB552A72ffA00BD23e9b2bB7b9579f6a35d4d560C` (verified source: https://repo.sourcify.dev/84532/0xB552A72ffA00BD23e9b2bB7b9579f6a35d4d560C). Read the rules below before you start.
- **acceptance_criteria:** A test or Base Sepolia transactions showing an address receiving escrowed USDC beyond what the contract's rules give it. Must reproduce against the published source.
- **evidence_required:** `[{"kind":"url","label":"Link to the failing test (gist or repo) or the testnet transactions"}]`

### 2. Freeze or trap money (High, up to $3)

- **title:** Lock up our escrow's USDC so nobody can get it back (testnet, up to $3)
- **category:** other
- **reward_amount_cents:** 300
- **settlement:** onchain
- **deadline:** 30 days after posting
- **description:** Every job's money in our escrow must always be able to leave: to the agent when the work is approved or the review window passes, or back to the poster on rejection, expiry or the agent giving up. Find a way to make a job's USDC permanently stuck, or to stop one person's payout by doing something to another person's job. Circle freezing an address is out of scope. Contract on Base Sepolia: `0xB552A72ffA00BD23e9b2bB7b9579f6a35d4d560C`.
- **acceptance_criteria:** A reproducible sequence that leaves USDC in the contract with no call that can ever move it to its rightful owner, or that blocks someone else's payout.
- **evidence_required:** `[{"kind":"url","label":"Link to the failing test or the testnet transactions"}]`

### 3. Send money to the wrong place (High, up to $3)

- **title:** Make our escrow pay the wrong address or the wrong fee (testnet, up to $3)
- **category:** other
- **reward_amount_cents:** 300
- **settlement:** onchain
- **deadline:** 30 days after posting
- **description:** A job's payout can only go to the agent named when it was funded (minus a fixed 5% fee to our treasury), and a refund can only go to the poster, with no fee. Find a way to redirect a payout or refund, change who the agent is, take a fee on a refund, or take more or less than 5% on a payout. Contract on Base Sepolia: `0xB552A72ffA00BD23e9b2bB7b9579f6a35d4d560C`.
- **acceptance_criteria:** A reproducible case where USDC from a job reaches an address other than its agent, poster or the treasury, or the fee differs from the contract's rules.
- **evidence_required:** `[{"kind":"url","label":"Link to the failing test or the testnet transactions"}]`

### 4. Break a launch limit or a timing rule (Medium, up to $2)

- **title:** Get around our escrow's limits or timing rules (testnet, up to $2)
- **category:** other
- **reward_amount_cents:** 200
- **settlement:** onchain
- **deadline:** 30 days after posting
- **description:** At launch our escrow refuses jobs over $100, more than 10 open jobs, or more than $500 held in total. A poster can't reclaim before the deadline, a stranger can't force payment before the 3-day review window ends, and nobody but the named agent can submit work. Find a way around any of these without losing anyone's money. Filling the limits by locking your own money is a known cost and out of scope. Contract on Base Sepolia: `0xB552A72ffA00BD23e9b2bB7b9579f6a35d4d560C`.
- **acceptance_criteria:** A reproducible case where the contract accepts a job or call that its stated limits or timing rules forbid.
- **evidence_required:** `[{"kind":"url","label":"Link to the failing test or the testnet transactions"}]`

## Before posting

1. Jason says yes to deploying the contract on Base Sepolia (needs a test wallet with free test ETH).
2. Verify the source on Basescan (Sepolia) and fill in the address on each listing.
3. Jason says yes to posting the four listings, and confirms he'll pay confirmed bugs from his wallet.
