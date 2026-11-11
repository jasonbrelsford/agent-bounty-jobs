// Deploys BountyEscrow to Base Sepolia (testnet only) with a throwaway key.
//
// The key is made fresh inside this run, is never printed or saved, and is
// gone when the run ends. The contract has no owner, so nothing ever needs
// that key again. While the run waits, someone sends the printed address a
// little free test ETH from a faucet; then it deploys, checks the settings on
// chain, and publishes the source on Sourcify (which Blockscout and other
// explorers read).
//
// Run by .github/workflows/deploy-escrow-testnet.yml. Never point this at mainnet.

import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { ethers } from "ethers";

// LOCAL_RPC and LOCAL_USDC exist only for a dry run on a local Hardhat node (chain 31337).
const LOCAL = Boolean(process.env.LOCAL_RPC);
const CHAIN_ID = LOCAL ? 31337n : 84532n; // Base Sepolia
const RPC = LOCAL ? process.env.LOCAL_RPC : "https://sepolia.base.org";
// Circle's test USDC on Base Sepolia.
const USDC = LOCAL ? process.env.LOCAL_USDC : "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const SOURCE = "project/src/BountyEscrow.sol";
const NAME = "BountyEscrow";

// Launch limits (USDC has 6 decimals).
const FEE_BPS = 500n; // 5%
const MIN = 1_000_000n; // $1
const MAX = 100_000_000n; // $100 per job
const MAX_OPEN = 10n;
const MAX_HELD = 500_000_000n; // $500 in total

const waitMinutes = Number(process.env.WAIT_MINUTES || 40);
const summary = process.env.GITHUB_STEP_SUMMARY;
const note = (s) => {
  console.log(s);
  if (summary) appendFileSync(summary, s + "\n\n");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const provider = new ethers.JsonRpcProvider(RPC, Number(CHAIN_ID), { staticNetwork: true });
const net = await provider.getNetwork();
if (net.chainId !== CHAIN_ID) throw new Error(`Wrong chain ${net.chainId}; this script only deploys to Base Sepolia`);

const usdc = new ethers.Contract(USDC, ["function symbol() view returns (string)", "function decimals() view returns (uint8)"], provider);
const [sym, dec] = await Promise.all([usdc.symbol(), usdc.decimals()]);
if (sym !== "USDC" || dec !== 6n) throw new Error(`Token check failed: ${sym} / ${dec}`);

const wallet = ethers.Wallet.createRandom().connect(provider);
note(`Throwaway deployer (testnet only): \`${wallet.address}\``);
note(`Waiting up to ${waitMinutes} minutes for free test ETH at that address.`);
console.log(`::notice title=Fund this address with Base Sepolia test ETH::${wallet.address}`);

const deadline = Date.now() + waitMinutes * 60_000;
let balance = 0n;
while (Date.now() < deadline) {
  balance = await provider.getBalance(wallet.address);
  if (balance > 0n) break;
  await sleep(15_000);
}
if (balance === 0n) throw new Error("No test ETH arrived; nothing was deployed.");
note(`Test ETH received: ${ethers.formatEther(balance)} ETH`);

const artifact = JSON.parse(readFileSync(new URL("../artifacts/src/BountyEscrow.sol/BountyEscrow.json", import.meta.url)));
const buildInfo = JSON.parse(readFileSync(new URL(`../artifacts/build-info/${artifact.buildInfoId}.json`, import.meta.url)));

const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
// The treasury on testnet is the throwaway deployer: test fees go nowhere useful, by design.
const args = [USDC, wallet.address, FEE_BPS, MIN, MAX, MAX_OPEN, MAX_HELD];
const escrow = await factory.deploy(...args);
const tx = escrow.deploymentTransaction();
note(`Deploy transaction: \`${tx.hash}\``);
await tx.wait(LOCAL ? 1 : 2);
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
const want = { token: USDC, treasury: wallet.address, feeBps: FEE_BPS, minAmount: MIN, maxAmount: MAX, maxOpenJobs: MAX_OPEN, maxHeld: MAX_HELD };
for (const k of Object.keys(want)) {
  if (String(got[k]).toLowerCase() !== String(want[k]).toLowerCase()) throw new Error(`Setting ${k} is ${got[k]}, expected ${want[k]}`);
}
const code = await provider.getCode(address);
if (code === "0x") throw new Error("No code at the deployed address");
note(`Deployed BountyEscrow at \`${address}\`; every setting read back from the chain matches.`);

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

const record = {
  network: LOCAL ? "local" : "base-sepolia",
  chainId: Number(CHAIN_ID),
  address,
  deployTx: tx.hash,
  deployer: wallet.address,
  deployerKey: "made inside the run and discarded; the contract has no owner",
  token: USDC,
  treasury: wallet.address,
  feeBps: Number(FEE_BPS),
  minAmount: MIN.toString(),
  maxAmount: MAX.toString(),
  maxOpenJobs: Number(MAX_OPEN),
  maxHeld: MAX_HELD.toString(),
  compiler: buildInfo.solcLongVersion,
  sourcify: verified,
  deployedAt: new Date().toISOString(),
};
writeFileSync("deployment.json", JSON.stringify(record, null, 2) + "\n");
console.log(JSON.stringify(record, null, 2));
