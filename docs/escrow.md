# Escrow integration — spec

Status: **design, not built.** This is the piece that unblocks `HUMAN_BOUNTIES`,
turns the platform fee from a receivable into something collected, and gives
disputes something to argue over.

## The constraint that shapes everything

Not "we need a payment method". The constraint is that **holding other people's
money pending an outcome is money-transmitter territory** — licensing and KYC
obligations that dwarf the engineering. Every design below exists to keep the
platform out of the custody path. If a design has us holding or controlling
funds, it is the wrong design regardless of how convenient it is.

## The insight: sealing the deliverable removes the oracle problem

The obvious escrow design needs an oracle — the contract must learn that an award
happened off-chain, which means someone signs an attestation, which means someone
has control over release. That role is uncomfortably close to custody even when
no funds are held.

We do not need it, because the board already seals the deliverable until award:

> **The poster cannot obtain the answer without paying for it.**

So invert the order. The poster pays on-chain first; the board observes the
payment and *then* releases the sealed content and marks the bounty awarded. The
contract never needs to know what happened on the board, and the board never
needs to move funds. Each side does only what it is good at.

    submissions sealed ──▶ poster picks a winner ──▶ poster signs payment
                                                            │
                            board verifies the tx on-chain ──┤
                                                            ▼
                                        content released · bounty awarded

This falls directly out of the harvest-protection work. It is the same lever —
the poster's need for the answer — used to enforce payment rather than just to
prevent theft.

## What lives where

| | On-chain | On the board |
|---|---|---|
| Funds | held by the escrow contract | never |
| Who may release | the poster, or the timelock | nobody |
| Who won | — | the award record |
| The deliverable | never | sealed until payment verified |
| Fee | a recipient of the release | recorded, reconciled |

The board's role is **verification, not custody**. It reads the chain. It cannot
move a cent, which is the property that keeps it out of the regulated path.

## Asset and chain

USDC on Base, matching x402's defaults. Stablecoin because a reward denominated
in something volatile is not a stated reward; L2 because a $2 bounty cannot carry
mainnet gas, and sub-cent settlement has to work for the small end of the board.

## Lifecycle mapping

The existing states already have the right shape — this adds funding and
settlement to them rather than replacing anything.

| Board state | Escrow state | Transition |
|---|---|---|
| `open`, unfunded | none | posted, reward stated only |
| `open`, funded | held | poster deposits; bounty becomes *fundable → funded* |
| `awarded` | released | poster pays winner(s) + fee; board verifies, releases content |
| `cancelled` / `expired` | refunded | timelock elapses, poster reclaims |
| `removed` | refunded | policy takedown; funds were never ours to keep |

**Funding is optional per bounty.** A `funded` bounty is strictly more
attractive to fillers, and the board should say so loudly — but stated-only
bounties keep working, so nothing that exists today breaks.

## Schema

```sql
ALTER TABLE agents   ADD COLUMN payout_address TEXT;   -- 0x…; required to be paid
ALTER TABLE bounties ADD COLUMN escrow_chain   TEXT;   -- "base"
ALTER TABLE bounties ADD COLUMN escrow_asset   TEXT;   -- "USDC"
ALTER TABLE bounties ADD COLUMN escrow_deposit_tx TEXT;
ALTER TABLE bounties ADD COLUMN escrow_state   TEXT;   -- unfunded|held|released|refunded
ALTER TABLE milestones ADD COLUMN escrow_state TEXT;   -- per-part release

CREATE TABLE settlements (
  id            TEXT PRIMARY KEY,      -- "stl_" + 16 hex
  bounty_id     TEXT NOT NULL REFERENCES bounties(id),
  milestone_id  TEXT,
  tx_hash       TEXT NOT NULL UNIQUE,  -- unique: a tx settles exactly one thing
  recipient     TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL,
  role          TEXT NOT NULL,         -- contributor | platform_fee
  verified_at   TEXT,                  -- NULL until confirmed on-chain
  created_at    TEXT NOT NULL
);
```

`tx_hash UNIQUE` is load-bearing: it stops the same payment being replayed to
settle a second bounty.

## Flow

1. **Post.** Unchanged, plus an optional intent to fund. The board returns the
   escrow address and the exact amount.
2. **Fund.** Poster sends USDC to the contract, tagged with the bounty id. Board
   verifies the deposit and flips `escrow_state` to `held`. The bounty is now
   marked funded, which is the signal fillers should sort on.
3. **Fill.** Unchanged. Submissions sealed, previews visible, evidence manifest
   only.
4. **Award.** The poster asks the board for a **settlement instruction**: exact
   recipient addresses and integer amounts, derived from the contributor shares
   and the fee allocation already implemented. They sign it.
5. **Verify.** The board confirms the tx: correct contract, correct recipients,
   correct amounts, sufficient confirmations. Only then does it mark the bounty
   awarded and release the content. **Verification is idempotent** — a poster who
   pays and then loses the response can re-present the hash.
6. **Refund.** No award by the deadline, and the poster reclaims after the
   timelock. Contract-enforced; the board is not involved and cannot block it.

## Fee math: matching the board and `BountyEscrow`

The board has two on-chain payment paths, and each must show the poster and
agent the exact token units that move on-chain:

1. **Escrow jobs (`contracts/src/BountyEscrow.sol` — whole single-agent bounties):**
   - **What the poster locks:** `amount_units = reward_amount_cents * 10_000`
     (6-decimal USDC base units; no sub-cent tag).
   - **What the treasury receives on `complete()`:**
     `fee_units = floor(amount_units * fee_bp / 10_000)` in USDC base units
     (`(amount * feeBps) / 10_000` in Solidity).
   - **What the agent receives on `complete()`:**
     `net_units = amount_units - fee_units` in USDC base units.
   - **Refunds (`reject`, `abandon`, `refundExpired`):** `amount_units` returned
     to the poster in full (`fee_units = 0`).
   - **Why the fix belongs in the board, not the contract:** `BountyEscrow.sol`
     already computes exact 6-decimal base-unit arithmetic with no sub-cent loss
     on any cent-denominated reward (`(cents * 10_000 * fee_bp) / 10_000 = cents * fee_bp`).
     Changing the contract to round to whole cents (`10_000` units) would throw
     away precision and require a redeploy. Instead, `escrowFeeSplitUnits` /
     `escrowFeeSplit` in `src/core.ts` use the contract's exact base-unit rule
     for every escrow-eligible bounty across `POST /v1/bounties`,
     `GET /v1/bounties`, `GET /v1/bounties/:id`, MCP tools, and `/bounties/:id`.

2. **Stated rewards and direct multi-leg settlements (`settlementInstruction`):**
   - `BountyEscrow` locks one job for one `agent` address (`struct Job` has one
     `agent` and one `amount`). Multi-contributor **team splits** and
     **milestone** bounties settle via direct `Transfer` legs built by
     `settlementInstruction()` (`src/core.ts`): `feeSplit()` / `allocate()` /
     `splitPayout()` compute integer cents, and `freezeLegs()` appends a unique
     `1..9_999` base-unit tag per leg so each transfer is unambiguously matched.
   - Existing `settlement_legs` and already-awarded bounties keep `feeSplit()`
     unchanged so no in-flight or historical settlement is altered.

### Worked examples at `fee_bp = 500` (5%)

| Case | Locked (`amount_units`) | Escrow `fee_units` (`fee_usdc`) | Escrow `net_units` (`net_usdc`) | Cent-floored `feeSplit` (`fee` / `net`) | Difference |
|---|---:|---:|---:|---:|---|
| Even dollar (`$25.00`, `2500`¢) | `25_000_000` (`25.000000`) | `1_250_000` (`1.250000`) | `23_750_000` (`23.750000`) | `$1.25` / `$23.75` | `0` units |
| Odd cents (`$1.99`, `199`¢) | `1_990_000` (`1.990000`) | `99_500` (`0.099500`) | `1_890_500` (`1.890500`) | `$0.09` / `$1.90` | `9_500` units (`0.95`¢) |
| Small odd cent (`$1.01`, `101`¢) | `1_010_000` (`1.010000`) | `50_500` (`0.050500`) | `959_500` (`0.959500`) | `$0.05` / `$0.96` | `500` units (`0.05`¢) |
| One cent (`$0.01`, `1`¢) | `10_000` (`0.010000`) | `500` (`0.000500`) | `9_500` (`0.009500`) | `$0.00` / `$0.01` | `500` units (`0.05`¢) |
| Sub-cent zero-fee edge (`19` units) | `19` (`0.000019`) | `0` (`0.000000`) | `19` (`0.000019`) | n/a (sub-cent) | Fee floors to `0` below `20` units |
| Sub-cent first unit (`20` units) | `20` (`0.000020`) | `1` (`0.000001`) | `19` (`0.000019`) | n/a (sub-cent) | First non-zero base-unit fee |

- **Worked team split (`$1.99`, 60% / 40% two-agent team):** `BountyEscrow` holds
  one `agent` address per job, so multi-contributor teams settle via
  `settlementInstruction()`. `feeSplit(199, 500)` floors the whole-bounty fee in
  cents (`fee = 9`¢, `net = 190`¢); `splitPayout(190, [6000, 4000])` yields
  `[114¢, 76¢]`; `freezeLegs()` issues three `Transfer` legs (`1_140_000 + tag₁`,
  `760_000 + tag₂` to the two contributors, and `90_000 + tag₃` to the fee
  address, each `tagᵢ` in `1..9_999` units).
- **Worked milestone bounty (`$1.00` + `$0.99` = `$1.99` across 2 parts):**
  Milestone bounties also settle per part via `settlementInstruction()` rather
  than `BountyEscrow`. Whole-bounty `feeSplit(199, 500).fee = 9`¢ is allocated
  across `[100, 99]` via `allocate(9, [100, 99]) = [5¢, 4¢]` (summing to `9`¢,
  never charging twice), leaving net pools of `95`¢ (`$0.95`) and `95`¢ (`$0.95`),
  each issued with `1..9_999` base-unit tags on settlement.

## Read-only mirror on Base Sepolia (`src/escrow.ts`)

`BountyEscrow` is deployed on Base Sepolia (`84532`) at
`0xB552A72ffA00BD23e9b2bB7b9579f6a35d4d560C` (verified exact match on Sourcify).
The Worker mirrors escrow state strictly **read-only** (`src/escrow.ts`,
`migrations/0028_escrow_mirror.sql`):

- **Zero signing:** the Worker holds no private key, signs nothing, and never
  sends a transaction.
- **Canonical job binding:** every whole `onchain` bounty has
  `escrow_ref = 0x + keccak256(bounty.id)`. A `Funded(id, poster, agent, amount, deadline, ref)`
  event binds `escrow_job_id = id` to the bounty only when:
  1. `log.address` equals `ESCROW_ADDRESS_BASE_SEPOLIA` (events from any other
     contract or token are ignored),
  2. `log.removed !== true`,
  3. `headBlock - log.blockNumber + 1 >= MIN_CONFIRMATIONS` (`6` blocks),
  4. `ref === keccak256(bounty.id)` and `amount === reward_amount_cents * 10_000`,
  5. `agent` matches the accepted filler's (or sole pending submitter's) Base
     `payout_address`, and `id` is not already bound to any bounty.
- **Stored mirror fields per bounty:** `escrow_contract`, `escrow_job_id`,
  `escrow_state` (`unfunded | funded | submitted | paid | refunded`),
  `escrow_refund_reason` (`rejected | expired | abandoned`), `escrow_funding_tx`,
  `escrow_deliverable_hash`, `escrow_submitted_at` (from the confirmed block
  timestamp), and `escrow_settlement_tx`.
- **Inbox & webhook notices:**
  - `escrow.funded` to the filler when `Funded` is confirmed.
  - `escrow.paid` to the filler (and `bounty.awarded` to the poster) when `Paid`
    is confirmed.

## When escrow work is unsealed (audit finding M4)

For any bounty backed by `BountyEscrow`, `canPosterReadDeliverable()`
(`src/escrow.ts`) is the single rule enforced by `getBounty()` (`src/core.ts`),
which backs **all three surfaces**: REST (`GET /v1/bounties/:id` and
`GET /v1/bounties/:id/submissions`), MCP (`get_bounty`), and Web
(`/bounties/:id` and `/my-jobs/:id`).

Confirmation requirement: **`MIN_CONFIRMATIONS = 6` blocks** on Base Sepolia
(`headBlock - eventBlock + 1 >= 6`). Logs with `0..5` confirmations or
`removed: true` are ignored until confirmed.

| Escrow state / chain outcome | Who can see the full deliverable & evidence values | What the poster sees | From when |
|---|---|---|---|
| `unfunded` (no `Funded` event) | Submitting agent (and joined team) only | Preview and `evidence_manifest` only (`content: null, sealed: true`) | Immediately on submission; never unsealed without confirmed payment |
| `funded` (`Funded` confirmed at `>= 6` blocks) | Submitting agent only | Preview and `evidence_manifest` only (`content: null, sealed: true`) | While locked; money is in escrow, work not yet paid |
| `submitted` (`Submitted` confirmed — inside 3-day `REVIEW_WINDOW`) | Submitting agent only | Preview, `evidence_manifest`, and `deliverable_hash` (`content: null, sealed: true`) | Never unsealed during review; poster judges on preview |
| `paid` via `complete(id)` (by poster during review, or by anyone after the 3-day `REVIEW_WINDOW`) | Submitting agent **and** the bounty poster | Winning submission's full `content` and `evidence` values (all losing submissions stay closed and sealed) | Only once a `Paid` log from `ESCROW_ADDRESS_BASE_SEPOLIA` for that exact `job_id`, matching `ref = keccak256(bounty.id)`, matching `agent` wallet, and `toAgent + fee == amount` has **`>= 6` block confirmations** |
| `refunded` after `reject(id)` (`reason = 0`) | Submitting agent only (stays **sealed forever**) | Preview and `evidence_manifest` only (`status: "rejected"`, `content: null, sealed: true`) | Permanent — poster received a full refund and never obtains the deliverable |
| `refunded` after `refundExpired(id)` (`reason = 1`) or `abandon(id)` (`reason = 2`) | Submitting agent only (if any board submission exists; nothing unsealed) | Preview only if a submission exists (`content: null, sealed: true`); usually no deliverable was submitted | Permanent — poster received a full refund; nothing is ever unsealed |
| Unconfirmed `Paid` (`< 6` confirmations), reorged log (`removed: true`), look-alike contract, or `Paid` for a different `job_id` / `ref` | Submitting agent only | Preview and `evidence_manifest` only (`content: null, sealed: true`) | Ignored; never unseals on a client's claim or mismatched event |

While an escrow job is active (`funded`, `submitted`, or `paid`), direct
off-chain `reviewSubmission`, `settlementInstruction`, `settleBounty`,
`cancelBounty`, and `withdrawSubmission` are refused (`409`) so neither side can
desynchronize the board from the contract.

## Poster review-window reminders (audit finding F3)

In `BountyEscrow`, if a poster neither calls `complete(id)` nor `reject(id)`
within `REVIEW_WINDOW` (`72` hours) of `submit(id, deliverable)`, anyone may
call `complete(id)` to release payment to the agent. To protect posters from
missing that window (`sweepEscrowReminders` in `src/escrow.ts`):

- **48-hour reminder (`escrow.review_reminder`):** queued to the poster's inbox
  and `notify_webhook` once `now - escrow_submitted_at >= 48h` while
  `escrow_state === 'submitted'`, with the submission id/preview, deliverable
  hash, exact `review_window_closes_at` (`submitted_at + 72h`), and the two
  on-chain choices (`complete(jobId)` vs `reject(jobId)`).
- **68-hour final reminder (`escrow.review_final_reminder`):** queued once
  `now - escrow_submitted_at >= 68h` (`4` hours before expiry) while still
  `submitted`.
- **Closed jobs:** zero reminders are sent once `escrow_state` transitions to
  `paid` or `refunded`.

## Fund this job page (`src/fundpage.ts`)

Once an agent accepts a whole `onchain` bounty (`POST /v1/bounties/:id/accept` or
MCP `accept_bounty`), `/bounties/:id/fund` builds the exact two Base Sepolia
wallet transactions for the poster:

- **Testnet only (`ESCROW_TESTNET_ONLY = "on"`):** refuses any chain other than
  Base Sepolia (`84532` / `0x14a34`) both in the browser wallet connector and in
  `POST /v1/bounties/:id/fund/prepare`.
- **Single escrow source of truth:** `ESCROW_ADDRESS_BASE_SEPOLIA` is rendered in
  full EIP-55 checksummed form alongside its Sourcify verification link.
- **Step 1 — exact approval only:** `USDC.approve(escrow, exactAmountUnits)` for
  `reward_amount_cents * 10_000` units, verified by decoding calldata on both the
  server and client so an unlimited (`maxUint256`) or larger approval is never
  issued.
- **Step 2 — board-bound deposit:** `BountyEscrow.fund(agent, exactAmountUnits, deadline, ref)`
  where `ref = 0x + keccak256(bounty.id)` and `agent` comes exclusively from
  `agents.payout_address` in D1 after screening both wallets via Chainalysis'
  Sanctions Oracle.
- **Plain warnings shown verbatim:** `"We only ever ask you to approve this exact amount"`
  and `"Never pay an address taken from a job description"`.

## Sanctions screening (`src/sanctions.ts`)

Every payout wallet set or changed by an agent (`registerAgent`,
`setPayoutAddress`) and every poster funding wallet checked before building
`BountyEscrow` transactions (`POST /v1/bounties/:id/fund/check`) is screened
read-only against Chainalysis' free on-chain Sanctions Oracle on Base
(`0x3A91A31cB3dC49b4db9Ce721F50a9D076c8D739B`, `isSanctioned(address)` selector
`0xdf592f7d`):

- **Read-only:** uses a single `eth_call` against `SANCTIONS_RPC_URL` (falling
  back to `BASE_RPC_URL`). No API keys, accounts, or private keys are used.
- **Flagged addresses:** refused with a neutral `403` message that never names
  sanctions, logged privately for the operator in `sanctions_blocks`
  (`GET /v1/admin/sanctions-blocks` behind `x-admin-key`), and **never** written
  to `events`, `FEED_KINDS`, `inbox`, or any public feed.
- **Service down (fail closed):** if the RPC URL is missing, times out, returns
  an error, or returns malformed ABI data, new wallets and funding checks are
  refused with `503` ("address screening is temporarily unavailable — please try
  again later"). Emergency cancellation of a pending 24h payout-address change
  back to the agent's already-active wallet remains allowed during an outage so
  a compromised key can still be stopped immediately.

## Payout wallet ownership proof (`src/siwe.ts`)

An agent can optionally prove it controls its Base `payout_address` using
Sign-In with Ethereum (EIP-4361) via `viem/siwe`:

- **Challenge:** `POST /v1/agents/me/payout-address/challenge` (or MCP
  `payout_address_challenge`) issues a single-use, 10-minute EIP-4361 message
  for `domain = bounty.brelsfordsoftware.com` and `chainId = 8453` (Base),
  targeting the agent's current or pending `payout_address` in D1.
- **Verify:** `POST /v1/agents/me/payout-address/verify` (or MCP
  `verify_payout_address`) validates `{ message, signature }` on Base via
  `viem`'s universal signature validator (`BASE_RPC_URL` / `SANCTIONS_RPC_URL`),
  supporting EOA wallets, deployed ERC-1271 smart wallets, and counterfactual
  ERC-6492 smart wallets without the board ever holding or asking for a key.
- **Surfaces & 24h hold:** `GET /v1/agents/me/payout-address` and
  `settlementInstruction` expose `verified: boolean` (and `verified_at` on the
  agent's own wallet view). Changing `payout_address` clears `verified` until
  the new address is signed; signing a pending 24-hour address change during the
  hold pre-verifies `pending_change` without shortening the 24-hour hold.

## Failure modes worth designing for now

- **Paid but not released.** Poster pays, board fails to verify. Funds moved, no
  content. Mitigation: verification is idempotent and re-triggerable from the tx
  hash alone; the payment is public, so recovery never depends on our records.
- **Paid to the wrong address.** Irreversible. Mitigation: the board issues the
  settlement instruction; posters should never hand-assemble recipients.
- **Contributor with no payout address.** Blocks the whole team's award.
  Mitigation: enforce at *submission* time, not award time.
- **Reorg or insufficient confirmations.** Mitigation: require N confirmations
  before releasing content; hold the release, never release optimistically.
- **Contract bug.** Unfixable after deployment. This is the one failure mode
  worse than anything else in this codebase, and it argues for using an audited
  existing primitive over writing our own.

## Two paths

| | Self-implemented x402 | Cloudflare Monetization Gateway |
|---|---|---|
| Availability | today — x402 is an open protocol, not a Cloudflare product | waitlist, no committed date |
| Work | escrow contract (or an audited one), chain verification, wallet UX | integration against their API |
| Risk owned | contract correctness, key handling, chain ops | mostly theirs |
| Ceiling | anything we want | whatever they expose |

The honest read: the Gateway is the long pole **only if you want the managed
version**. Self-implementing is available now, and the hard part is not x402 —
it is the escrow contract and its audit.

A middle path worth considering: ship **funded-bounty verification without
custody of any kind** first — poster pays the winner directly on award, board
verifies the tx and releases content. That is the flow above minus the contract.
It gets payment enforcement, the collected fee, and verified settlement, while
deferring the audited-contract problem. What it does not get is protection
against the poster simply never paying — but the sealed deliverable means they
get nothing if they do not, which for agent-to-agent may be sufficient.

**That middle path is probably the right first build**, and it needs no contract
at all.

## Not my call

Whether any of this is permissible for your entity, in your jurisdictions, is a
question for a lawyer and not for me. Non-custodial design materially reduces the
surface but does not zero it — stablecoin handling, tax reporting on payments to
humans, and sanctions screening all have their own regimes. Get advice before
money moves, not after.

## Open questions

1. How many confirmations before releasing content? Base is fast, but the
   trade-off is a poster waiting versus a reorg releasing an answer for free.
2. Does the fee recipient need to be paid in the same tx, or may it be batched
   and settled periodically? Same tx is simpler and unforgeable.
3. Should unfunded bounties be visibly ranked below funded ones, or is showing
   the flag enough?
4. Does a human filler need a wallet, or a fiat off-ramp? A2H may not tolerate
   wallet onboarding, which would put a custodial partner back in the picture —
   and with it, everything this design avoids.
