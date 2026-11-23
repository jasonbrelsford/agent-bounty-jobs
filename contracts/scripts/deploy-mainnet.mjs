// Deploys BountyEscrow to Base mainnet (real USDC) with a throwaway key.
//
// Same flow as deploy-testnet.mjs, with real-money guards:
//   - the treasury (where the 5% fee goes) must be given as an input and is
//     checked to be a real address, not the deployer and not the zero address;
//   - the run must be confirmed by typing DEPLOY-MAINNET;
//   - the token is Circle's USDC on Base, checked by symbol, name and decimals;
//   - the key is made fresh inside the run, never printed or saved, and the
//     contract has no owner, so nothing ever needs that key again;
//   - after deploying, every setting is read back from the chain, the source is
//     published on Sourcify, and leftover ETH goes back to the treasury.
//
// The only thing a person does is send the printed deployer address a little
// ETH on Base (about $1 covers it; the deploy costs cents). No USDC is moved.
//
// Run by .github/workflows/deploy-escrow-mainnet.yml.

import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { ethers } from "ethers";

// LOCAL_RPC and LOCAL_USDC exist only for a dry run on a local Hardhat node (chain 31337).
const LOCAL = Boolean(process.env.LOCAL_RPC);
const CHAIN_ID = LOCAL ? 31337n : 8453n; // Base mainnet
const RPC = LOCAL ? process.env.LOCAL_RPC : process.env.BASE_RPC_URL || "https://mainnet.base.org";
// Circle's USDC on Base.
const USDC = LOCAL ? process.env.LOCAL_USDC : "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SOURCE = "project/src/BountyEscrow.sol";
const NAME = "BountyEscrow";

// Launch limits (USDC has 6 decimals). Same as testnet.
const FEE_BPS = 500n; // 5%
const MIN = 1_000_000n; // $1
const MAX = 100_000_000n; // $100 per job
const MAX_OPEN = 10n;
const MAX_HELD = 500_000_000n; // $500 in total

const waitMinutes = Number(process.env.WAIT_MINUTES || 60);
const summary = process.env.GITHUB_STEP_SUMMARY;
const note = (s) => {
  console.log(s);
  if (summary) appendFileSync(summary, s + "\n\n");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if ((process.env.CONFIRM || "").trim() !== "DEPLOY-MAINNET") {
  throw new Error("Not confirmed: type DEPLOY-MAINNET to deploy with real money. Nothing was done.");
}
const treasuryRaw = (process.env.TREASURY || "").trim();
if (!ethers.isAddress(treasuryRaw)) throw new Error("TREASURY must be a 0x wallet address. Nothing was done.");
const TREASURY = ethers.getAddress(treasuryRaw);
if (TREASURY === ethers.ZeroAddress) throw new Error("TREASURY cannot be the zero address. Nothing was done.");

const provider = new ethers.JsonRpcProvider(RPC, Number(CHAIN_ID), { staticNetwork: true });
const net = await provider.getNetwork();
if (net.chainId !== CHAIN_ID) throw new Error(`Wrong chain ${net.chainId}; this script only deploys to Base mainnet`);

const usdc = new ethers.Contract(
  USDC,
  ["function symbol() view returns (string)", "function decimals() view returns (uint8)", "function name() view returns (string)"],
  provider,
);
const [sym, dec, tokenName] = await Promise.all([usdc.symbol(), usdc.decimals(), usdc.name()]);
if (sym !== "USDC" || dec !== 6n) throw new Error(`Token check failed: ${sym} / ${dec}`);
if (!LOCAL && tokenName !== "USD Coin") throw new Error(`Token name check failed: ${tokenName}`);

const wallet = ethers.Wallet.createRandom().connect(provider);
if (wallet.address === TREASURY) throw new Error("Treasury equals the throwaway deployer");
note(`Treasury (gets the 5% fee): \`${TREASURY}\``);
note(`Throwaway deployer on Base mainnet: \`${wallet.address}\``);
note(`Send about $1 of ETH on Base to that address. Waiting up to ${waitMinutes} minutes.`);
console.log(`::notice title=Send a little ETH on Base (mainnet) to this address::${wallet.address}`);
// Logs only appear once the run ends, so also post the address (never the key)
// as a commit status, which can be read while the run waits.
if (process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY && process.env.GITHUB_SHA) {
  try {
    const r = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/statuses/${process.env.GITHUB_SHA}`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: "application/vnd.github+json" },
      body: JSON.stringify({ state: "pending", context: "mainnet-deployer-address", description: wallet.address }),
    });
    if (!r.ok) console.log(`Could not post the address as a status: ${r.status}`);
  } catch (e) {
    console.log(`Could not post the address as a status: ${e.message}`);
  }
}

const deadline = Date.now() + waitMinutes * 60_000;
let balance = 0n;
while (Date.now() < deadline) {
  balance = await provider.getBalance(wallet.address);
  if (balance > 0n) break;
  await sleep(15_000);
}
if (balance === 0n) throw new Error("No ETH arrived; nothing was deployed.");
note(`ETH received: ${ethers.formatEther(balance)} ETH`);

const artifact = JSON.parse(readFileSync(new URL("../artifacts/src/BountyEscrow.sol/BountyEscrow.json", import.meta.url)));
const buildInfo = JSON.parse(readFileSync(new URL(`../artifacts/build-info/${artifact.buildInfoId}.json`, import.meta.url)));

const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
const args = [USDC, TREASURY, FEE_BPS, MIN, MAX, MAX_OPEN, MAX_HELD];
const escrow = await factory.deploy(...args);
const tx = escrow.deploymentTransaction();
note(`Deploy transaction: \`${tx.hash}\``);
const receipt = await tx.wait(LOCAL ? 1 : 3);
const address = await escrow.getAddress();

// Read every setting back from the chain.
const got = {
  token: await escrow.token(),
  treasury: await escrow.treasury(),
  feeBps: await escrow.feeBps(),
  minAmount: await escrow.minAmount(),
  maxAmount: await escrow.maxAmount(),
  maxOpenJobs: await escrow.maxOpenJobs(),
  maxHeld: await escrow.maxHeld(),
};
const want = { token: USDC, treasury: TREASURY, feeBps: FEE_BPS, minAmount: MIN, maxAmount: MAX, maxOpenJobs: MAX_OPEN, maxHeld: MAX_HELD };
for (const k of Object.keys(want)) {
  if (String(got[k]).toLowerCase() !== String(want[k]).toLowerCase()) throw new Error(`Setting ${k} is ${got[k]}, expected ${want[k]}`);
}
const code = await provider.getCode(address);
if (code === "0x") throw new Error("No code at the deployed address");
note(`Deployed BountyEscrow at \`${address}\` in block ${receipt.blockNumber}; every setting read back from the chain matches.`);

// Publish the source on Sourcify.
let verified = "not attempted";
if (!LOCAL) try {
  const res = await fetch(`https://sourcify.dev/server/v2/verify/${CHAIN_ID}/${address}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      stdJsonInput: buildInfo.input,
      compilerVersion: buildInfo.solcLongVersion,
      contractIdentifier: `${SOURCE}:${NAME}`,
      creationTransactionHash: tx.hash,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`);
  verified = "pending";
  for (let i = 0; i < 40; i++) {
    await sleep(6_000);
    const job = await (await fetch(`https://sourcify.dev/server/v2/verify/${body.verificationId}`)).json();
    if (job.isJobCompleted) {
      verified = job.error ? `failed: ${JSON.stringify(job.error)}` : `${job.contract?.match ?? "done"}`;
      break;
    }
  }
} catch (e) {
  verified = `failed: ${e.message}`;
}
note(`Source on Sourcify: ${verified}`);

// Send leftover ETH back to the treasury so nothing is stranded on a key that is about to vanish.
let refund = "none";
try {
  const left = await provider.getBalance(wallet.address);
  const fee = await provider.getFeeData();
  const maxFee = (fee.maxFeePerGas ?? fee.gasPrice ?? 0n) * 2n;
  const prio = fee.maxPriorityFeePerGas ?? 0n;
  const gas = 21_000n;
  // OP-stack chains also charge a small L1 data fee; keep a margin for it.
  const reserve = gas * maxFee + 20_000_000_000_000n; // + 0.00002 ETH
  if (left > reserve) {
    const nonce = await provider.getTransactionCount(wallet.address, "latest");
    const r = await wallet.sendTransaction({ to: TREASURY, value: left - reserve, gasLimit: gas, maxFeePerGas: maxFee, maxPriorityFeePerGas: prio, nonce });
    await r.wait(1);
    refund = `${ethers.formatEther(left - reserve)} ETH back to the treasury in \`${r.hash}\``;
  }
} catch (e) {
  refund = `failed: ${e.message}`;
}
note(`Leftover ETH: ${refund}`);

const record = {
  network: LOCAL ? "local" : "base",
  chainId: Number(CHAIN_ID),
  address,
  deployTx: tx.hash,
  deployBlock: Number(receipt.blockNumber),
  deployer: wallet.address,
  deployerKey: "made inside the run and discarded; the contract has no owner",
  token: USDC,
  treasury: TREASURY,
  feeBps: Number(FEE_BPS),
  minAmount: MIN.toString(),
  maxAmount: MAX.toString(),
  maxOpenJobs: Number(MAX_OPEN),
  maxHeld: MAX_HELD.toString(),
  compiler: buildInfo.solcLongVersion,
  sourcify: verified,
  refund,
  deployedAt: new Date().toISOString(),
};
writeFileSync("deployment.json", JSON.stringify(record, null, 2) + "\n");
console.log(JSON.stringify(record, null, 2));
note(`Next: set ESCROW_ADDRESS_BASE=${address} and ESCROW_DEPLOY_BLOCK_BASE=${receipt.blockNumber} in wrangler.jsonc, then ESCROW_TESTNET_ONLY="off".`);
