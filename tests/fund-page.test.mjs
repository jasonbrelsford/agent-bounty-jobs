// Fund this job page (#49): exact-amount USDC approve + BountyEscrow.fund
// against a real local Hardhat node (Base Sepolia chainId 84532), exact-approval
// invariant checks, testnet chain refusal, and sanctions screening integration.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import solc from "solc";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  http,
  maxUint256,
  parseAbi,
} from "viem";
import { baseSepolia } from "viem/chains";
import { makeD1 } from "./d1shim.mjs";
import worker from "../.test-build/index.js";
import {
  registerAgent,
  authByKey,
  postBounty,
  acceptBounty,
  getBounty,
  recentActivity,
} from "../.test-build/core.js";
import { bountyEscrowRef } from "../.test-build/escrow.js";
import {
  ERC20_APPROVE_ABI,
  ESCROW_FUND_ABI,
  EXACT_APPROVE_WARNING,
  NEVER_PAY_DESCRIPTION_WARNING,
  assertAllowedFundingChain,
  buildEscrowFundingTransactions,
  fundJobFromPage,
} from "../.test-build/fundpage.js";

const CTX = { waitUntil: () => {} };
const ORIGIN = "https://bounty.brelsfordsoftware.com";

const ORACLE_SOL = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
contract MockSanctionsOracle {
    mapping(address => bool) public sanctioned;
    function setSanctioned(address a, bool on) external { sanctioned[a] = on; }
    function isSanctioned(address a) external view returns (bool) { return sanctioned[a]; }
}
`;

let compiledCache = null;
function compileContracts() {
  if (compiledCache) return compiledCache;
  const root = process.cwd();
  const sources = {
    "BountyEscrow.sol": {
      content: fs.readFileSync(path.join(root, "contracts/src/BountyEscrow.sol"), "utf8"),
    },
    "MockUSDC.sol": {
      content: fs.readFileSync(path.join(root, "contracts/test/mocks/MockUSDC.sol"), "utf8"),
    },
    "MockSanctionsOracle.sol": { content: ORACLE_SOL },
  };
  function findImports(importPath) {
    const candidate = path.join(root, "node_modules", importPath);
    if (fs.existsSync(candidate)) {
      return { contents: fs.readFileSync(candidate, "utf8") };
    }
    return { error: `File not found: ${importPath}` };
  }
  const output = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources,
        settings: {
          outputSelection: { "*": { "*": ["abi", "evm.bytecode"] } },
        },
      }),
      { import: findImports },
    ),
  );
  const errs = (output.errors ?? []).filter((e) => e.severity === "error");
  assert.equal(errs.length, 0, `Solidity compile errors: ${JSON.stringify(errs)}`);
  compiledCache = {
    escrow: {
      abi: output.contracts["BountyEscrow.sol"].BountyEscrow.abi,
      bytecode: `0x${output.contracts["BountyEscrow.sol"].BountyEscrow.evm.bytecode.object}`,
    },
    usdc: {
      abi: output.contracts["MockUSDC.sol"].MockUSDC.abi,
      bytecode: `0x${output.contracts["MockUSDC.sol"].MockUSDC.evm.bytecode.object}`,
    },
    oracle: {
      abi: output.contracts["MockSanctionsOracle.sol"].MockSanctionsOracle.abi,
      bytecode: `0x${output.contracts["MockSanctionsOracle.sol"].MockSanctionsOracle.evm.bytecode.object}`,
    },
  };
  return compiledCache;
}

async function startLocalHardhatEnv() {
  const artifacts = compileContracts();
  const hre = await createHardhatRuntimeEnvironment({
    networks: {
      localSepolia: { type: "edr-simulated", chainId: 84532 },
    },
  });
  const server = await hre.network.createServer("localSepolia", "127.0.0.1", 0);
  const { address, port } = await server.listen();
  const rpcUrl = `http://${address}:${port}`;

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl),
  });
  const walletClient = createWalletClient({
    chain: baseSepolia,
    transport: http(rpcUrl),
  });

  const accountsRes = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_accounts", params: [] }),
  }).then((r) => r.json());
  const [deployer, posterWallet, fillerWallet, treasuryWallet, flaggedWallet] =
    accountsRes.result.map((a) => getAddress(a));

  // Deploy MockUSDC, MockSanctionsOracle, and BountyEscrow
  const usdcHash = await walletClient.deployContract({
    account: deployer,
    abi: artifacts.usdc.abi,
    bytecode: artifacts.usdc.bytecode,
  });
  const usdcAddress = getAddress(
    (await publicClient.waitForTransactionReceipt({ hash: usdcHash })).contractAddress,
  );

  const oracleHash = await walletClient.deployContract({
    account: deployer,
    abi: artifacts.oracle.abi,
    bytecode: artifacts.oracle.bytecode,
  });
  const oracleAddress = getAddress(
    (await publicClient.waitForTransactionReceipt({ hash: oracleHash })).contractAddress,
  );

  const escrowHash = await walletClient.deployContract({
    account: deployer,
    abi: artifacts.escrow.abi,
    bytecode: artifacts.escrow.bytecode,
    args: [
      usdcAddress,
      treasuryWallet,
      500n, // 5% fee
      1_000_000n, // $1.00 minAmount
      100_000_000n, // $100.00 maxAmount
      10n, // maxOpenJobs
      3n, // maxOpenJobsPerPoster
      1_000_000_000n, // $1,000.00 maxHeld
    ],
  });
  const escrowAddress = getAddress(
    (await publicClient.waitForTransactionReceipt({ hash: escrowHash })).contractAddress,
  );

  async function rpcCall(method, params = []) {
    const r = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }).then((x) => x.json());
    if (r.error) throw new Error(`${method}: ${r.error.message}`);
    return r.result;
  }

  async function mineBlocks(count) {
    for (let i = 0; i < count; i++) {
      await rpcCall("evm_mine", []);
    }
  }

  /** Build a browser-like EIP-1193 injected wallet backed by the Hardhat node for one account. */
  function makeInjectedWallet(activeAccount, overrideChainHex = null) {
    const sentTransactions = [];
    return {
      sentTransactions,
      provider: {
        async request({ method, params = [] }) {
          if (method === "eth_chainId") {
            return overrideChainHex ?? (await rpcCall("eth_chainId", []));
          }
          if (method === "eth_requestAccounts" || method === "eth_accounts") {
            return [activeAccount];
          }
          if (method === "eth_sendTransaction") {
            sentTransactions.push(params[0]);
            return rpcCall("eth_sendTransaction", params);
          }
          return rpcCall(method, params);
        },
      },
    };
  }

  return {
    server,
    rpcUrl,
    artifacts,
    publicClient,
    walletClient,
    deployer,
    posterWallet,
    fillerWallet,
    treasuryWallet,
    flaggedWallet,
    usdcAddress,
    oracleAddress,
    escrowAddress,
    mineBlocks,
    makeInjectedWallet,
  };
}

test("Against a local Hardhat node with BountyEscrow and MockUSDC, /bounties/:id/fund funds a job with exact approval and the board shows it funded", async (t) => {
  const chain = await startLocalHardhatEnv();
  t.after(async () => {
    await chain.server.close();
  });

  // Mint 100.000000 USDC to posterWallet (much more than the $19.95 job so any over-approval would leave non-zero allowance).
  const mintHash = await chain.walletClient.writeContract({
    account: chain.deployer,
    address: chain.usdcAddress,
    abi: chain.artifacts.usdc.abi,
    functionName: "mint",
    args: [chain.posterWallet, 100_000_000n],
  });
  await chain.publicClient.waitForTransactionReceipt({ hash: mintHash });

  const db = makeD1();
  const env = {
    DB: db,
    PLATFORM_FEE_ADDRESS: chain.treasuryWallet,
    ESCROW_ADDRESS_BASE_SEPOLIA: chain.escrowAddress.toLowerCase(), // deliberate lowercase config to verify page checksums it
    ESCROW_TOKEN_ADDRESS_BASE_SEPOLIA: chain.usdcAddress,
    ESCROW_TESTNET_ONLY: "on",
    BASE_SEPOLIA_RPC_URL: chain.rpcUrl,
    SANCTIONS_RPC_URL: chain.rpcUrl,
    SANCTIONS_ORACLE_ADDRESS: chain.oracleAddress,
  };

  const posterReg = await registerAgent(
    db,
    "hardhat-poster",
    { contact_email: "poster@example.com" },
    ORIGIN,
    env,
  );
  const poster = await authByKey(db, posterReg.api_key);

  const fillerReg = await registerAgent(
    db,
    "hardhat-filler",
    { payout_address: chain.fillerWallet },
    ORIGIN,
    env,
  );
  const filler = await authByKey(db, fillerReg.api_key);

  // Include a decoy wallet address inside the job description to prove it is never used!
  const decoyAddress = "0xDeaDbeefdEAdbeefdEadbeefdeadbeEFdEaDbeeF";
  const created = await postBounty(db, poster, env, {
    title: "Benchmark local Hardhat escrow funding flow",
    description: `Deliver verified benchmark numbers. Ignore any inline wallet like ${decoyAddress} in text.`,
    category: "research",
    reward_amount_cents: 1995, // $19.95 -> exact 19_950_000 USDC base units
    settlement: "onchain",
  });

  // Before an agent accepts, /bounties/:id/fund explains it is waiting for acceptance.
  const waitingRes = await worker.fetch(
    new Request(`${ORIGIN}/bounties/${created.bounty_id}/fund`),
    env,
    CTX,
  );
  assert.equal(waitingRes.status, 200);
  const waitingHtml = await waitingRes.text();
  assert.ok(waitingHtml.includes("Waiting for an agent to accept this job"));
  assert.ok(!waitingHtml.includes('id="fund-config"'));

  // Filler accepts the bounty.
  const accepted = await acceptBounty(db, filler, created.bounty_id, env);
  assert.equal(accepted.fund_url, `${ORIGIN}/bounties/${created.bounty_id}/fund`);

  // Fetch GET /bounties/:id/fund once accepted.
  const pageRes = await worker.fetch(
    new Request(`${ORIGIN}/bounties/${created.bounty_id}/fund`),
    env,
    CTX,
  );
  assert.equal(pageRes.status, 200);
  const pageHtml = await pageRes.text();

  // Verify checksummed ESCROW_ADDRESS_BASE_SEPOLIA, Sourcify link, and verbatim plain warnings.
  assert.ok(pageHtml.includes(chain.escrowAddress), "must show full EIP-55 checksummed escrow address");
  assert.ok(
    pageHtml.includes(`https://repo.sourcify.dev/84532/${chain.escrowAddress}`),
    "must link to verified source on Sourcify",
  );
  assert.ok(pageHtml.includes(EXACT_APPROVE_WARNING));
  assert.ok(pageHtml.includes(NEVER_PAY_DESCRIPTION_WARNING));
  assert.ok(!pageHtml.toLowerCase().includes(decoyAddress.toLowerCase()), "must never render job description text/addresses on fund page");

  const workerFetch = (url, init) => worker.fetch(new Request(url, init), env, CTX);
  const { provider, sentTransactions } = chain.makeInjectedWallet(chain.posterWallet);

  const funded = await fundJobFromPage({
    pageHtml,
    origin: ORIGIN,
    ethereum: provider,
    fetchImpl: workerFetch,
    onAfterFundSent: async () => {
      // Mine 6 confirmation blocks on local Hardhat so MIN_CONFIRMATIONS (6) is satisfied.
      await chain.mineBlocks(6);
    },
  });

  assert.equal(sentTransactions.length, 2, "poster wallet should sign exactly 2 transactions (approve, fund)");

  // Inspect Step 1 (approve) transaction sent by the page:
  const decodedApprove = decodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    data: sentTransactions[0].data,
  });
  assert.equal(decodedApprove.functionName, "approve");
  assert.equal(getAddress(decodedApprove.args[0]), chain.escrowAddress);
  assert.equal(decodedApprove.args[1], 19_950_000n, "approval MUST be exact 19.950000 USDC");

  // Inspect Step 2 (fund) transaction sent by the page:
  const decodedFund = decodeFunctionData({
    abi: ESCROW_FUND_ABI,
    data: sentTransactions[1].data,
  });
  assert.equal(decodedFund.functionName, "fund");
  assert.equal(getAddress(decodedFund.args[0]), chain.fillerWallet);
  assert.equal(decodedFund.args[1], 19_950_000n);
  assert.equal(decodedFund.args[3], bountyEscrowRef(created.bounty_id));

  // Verify on-chain state on local Hardhat:
  // Because approve was strictly exact (19_950_000n), transferFrom consumed 100% of the allowance -> 0n left!
  const remainingAllowance = await chain.publicClient.readContract({
    address: chain.usdcAddress,
    abi: chain.artifacts.usdc.abi,
    functionName: "allowance",
    args: [chain.posterWallet, chain.escrowAddress],
  });
  assert.equal(remainingAllowance, 0n, "remaining allowance on MockUSDC must be 0 after exact approve + fund");

  const escrowBalance = await chain.publicClient.readContract({
    address: chain.usdcAddress,
    abi: chain.artifacts.usdc.abi,
    functionName: "balanceOf",
    args: [chain.escrowAddress],
  });
  assert.equal(escrowBalance, 19_950_000n);

  const jobOnChain = await chain.publicClient.readContract({
    address: chain.escrowAddress,
    abi: chain.artifacts.escrow.abi,
    functionName: "jobs",
    args: [1n],
  });
  assert.equal(getAddress(jobOnChain[0]), chain.posterWallet);
  assert.equal(jobOnChain[1], 19_950_000n);
  assert.equal(getAddress(jobOnChain[2]), chain.fillerWallet);
  assert.equal(Number(jobOnChain[5]), 1); // State.Funded

  // Verify the board now shows the bounty funded across domain, public bounty HTML, and fund page HTML!
  assert.equal(funded.sync.escrow.state, "funded");
  assert.equal(funded.sync.escrow.job_id, 1);

  const boardView = await getBounty(db, created.bounty_id, poster, undefined, env);
  assert.equal(boardView.bounty.escrow.state, "funded");
  assert.equal(boardView.bounty.escrow.job_id, 1);
  assert.equal(boardView.bounty.escrow.funding_tx, funded.fundTxHash.toLowerCase());
  assert.equal(boardView.bounty.escrow.fund_url, null);

  const bountyHtmlRes = await worker.fetch(
    new Request(`${ORIGIN}/bounties/${created.bounty_id}`),
    env,
    CTX,
  );
  const bountyHtml = await bountyHtmlRes.text();
  assert.ok(bountyHtml.includes(">funded<"));
  assert.ok(bountyHtml.includes("#1"));

  const postFundPageHtml = await (
    await worker.fetch(new Request(`${ORIGIN}/bounties/${created.bounty_id}/fund`), env, CTX)
  ).text();
  assert.ok(postFundPageHtml.includes("already <strong>funded</strong>"));
});

test("Approval is always the exact reward amount and client refuses any over-approval or unlimited allowance", async () => {
  const escrow = "0xB552A72ffA00BD23e9b2bB7b9579f6a35d4d560C";
  const token = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  const agent = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
  const ref = bountyEscrowRef("bty_0123456789abcdef");
  const deadlineUnix = Math.floor(Date.now() / 1000) + 86_400;

  for (const cents of [100, 101, 199, 1995, 2500, 4237, 9999, 10000]) {
    const exactUnits = BigInt(cents) * 10_000n;
    const [approveStep, fundStep] = buildEscrowFundingTransactions({
      escrowAddress: escrow,
      tokenAddress: token,
      agentPayoutAddress: agent,
      exactAmountUnits: exactUnits,
      deadlineUnix,
      ref,
    });
    const dec = decodeFunctionData({ abi: ERC20_APPROVE_ABI, data: approveStep.data });
    assert.equal(dec.functionName, "approve");
    assert.equal(dec.args[0], escrow);
    assert.equal(dec.args[1], exactUnits, `approval for ${cents} cents must be strictly ${exactUnits}`);
    assert.ok(dec.args[1] < maxUint256, "approval must never be maxUint256");

    const decFund = decodeFunctionData({ abi: ESCROW_FUND_ABI, data: fundStep.data });
    assert.equal(decFund.args[1], exactUnits);
  }

  // Unlimited (maxUint256) or zero amounts are rejected by the builder itself.
  assert.throws(() =>
    buildEscrowFundingTransactions({
      escrowAddress: escrow,
      tokenAddress: token,
      agentPayoutAddress: agent,
      exactAmountUnits: maxUint256,
      deadlineUnix,
      ref,
    }),
  );

  // Even if a tampered network response returned approve(escrow, exactUnits + 1n) or maxUint256,
  // fundJobFromPage MUST fail closed before sending any wallet transaction.
  const exactUnits = 25_000_000n;
  const cfg = {
    bounty_id: "bty_0123456789abcdef",
    chain_id: 84532,
    chain_id_hex: "0x14a34",
    testnet_only: true,
    escrow_address: escrow,
    sourcify_url: `https://repo.sourcify.dev/84532/${escrow}`,
    token_address: token,
    agent_id: "agt_1",
    agent_name: "filler",
    agent_payout_address: agent,
    exact_amount_units: exactUnits.toString(),
    exact_amount_usdc: "25.000000",
    net_usdc: "23.750000",
    fee_usdc: "1.250000",
    ref,
    confirmations_required: 6,
    prepare_url: "/v1/bounties/bty_0123456789abcdef/fund/prepare",
    sync_url: "/v1/bounties/bty_0123456789abcdef/escrow/sync",
    bounty_url: "/bounties/bty_0123456789abcdef",
  };
  const fakeHtml =
    `<p>${escrow} ${cfg.sourcify_url} ${EXACT_APPROVE_WARNING} ${NEVER_PAY_DESCRIPTION_WARNING}</p>` +
    `<script id="fund-config" type="application/json">${JSON.stringify(cfg)}</script>`;

  const [validStep1, validStep2] = buildEscrowFundingTransactions({
    escrowAddress: escrow,
    tokenAddress: token,
    agentPayoutAddress: agent,
    exactAmountUnits: exactUnits,
    deadlineUnix,
    ref,
  });

  // Case A: Step 1 over-approves (`exactUnits + 1n` or `maxUint256`) -> rejected before signing anything.
  for (const badAmount of [exactUnits + 1n, maxUint256]) {
    const sent = [];
    const badApproveData = encodeFunctionData({
      abi: ERC20_APPROVE_ABI,
      functionName: "approve",
      args: [escrow, badAmount],
    });
    const fakeEth = {
      async request({ method, params }) {
        if (method === "eth_chainId") return "0x14a34";
        if (method === "eth_requestAccounts") return ["0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB"];
        if (method === "eth_sendTransaction") {
          sent.push(params[0]);
          return "0x" + "11".repeat(32);
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    await assert.rejects(
      () =>
        fundJobFromPage({
          pageHtml: fakeHtml,
          origin: ORIGIN,
          ethereum: fakeEth,
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                steps: [
                  { step: 1, action: "approve", chainId: 84532, to: token, data: badApproveData, value: "0x0" },
                  validStep2,
                ],
              }),
              { status: 200 },
            ),
        }),
      /Refusing non-exact approve/,
    );
    assert.equal(sent.length, 0, "wallet must never be asked to sign an over-approval in Step 1");
  }

  // Case B: Step 1 is valid exact approve, but Step 2 smuggles an unlimited `approve(escrow, maxUint256)`
  // or a TOCTOU-swapped `agent` payout wallet -> rejected BEFORE Step 1 is ever sent!
  const smuggledApproveInStep2 = {
    step: 2,
    action: "fund",
    chainId: 84532,
    to: token,
    data: encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: "approve", args: [escrow, maxUint256] }),
    value: "0x0",
  };
  const swappedAgentStep2 = buildEscrowFundingTransactions({
    escrowAddress: escrow,
    tokenAddress: token,
    agentPayoutAddress: "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359", // different from cfg.agent_payout_address!
    exactAmountUnits: exactUnits,
    deadlineUnix,
    ref,
  })[1];

  for (const badStep2 of [smuggledApproveInStep2, swappedAgentStep2]) {
    const sent = [];
    const fakeEth = {
      async request({ method, params }) {
        if (method === "eth_chainId") return "0x14a34";
        if (method === "eth_requestAccounts") return ["0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB"];
        if (method === "eth_sendTransaction") {
          sent.push(params[0]);
          return "0x" + "11".repeat(32);
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    await assert.rejects(
      () =>
        fundJobFromPage({
          pageHtml: fakeHtml,
          origin: ORIGIN,
          ethereum: fakeEth,
          fetchImpl: async () =>
            new Response(
              JSON.stringify({ steps: [validStep1, badStep2] }),
              { status: 200 },
            ),
        }),
      /Refusing (invalid Step 2|mismatched Step 2)/,
    );
    assert.equal(sent.length, 0, "wallet must never sign Step 1 when Step 2 is tampered or TOCTOU-mismatched");
  }
});

test("Page and /fund/prepare refuse any chain other than Base Sepolia while testnet flag is on, and block sanctioned wallets", async (t) => {
  const chain = await startLocalHardhatEnv();
  t.after(async () => {
    await chain.server.close();
  });

  // Mark flaggedWallet on the local MockSanctionsOracle
  const flagHash = await chain.walletClient.writeContract({
    account: chain.deployer,
    address: chain.oracleAddress,
    abi: chain.artifacts.oracle.abi,
    functionName: "setSanctioned",
    args: [chain.flaggedWallet, true],
  });
  await chain.publicClient.waitForTransactionReceipt({ hash: flagHash });

  const db = makeD1();
  const env = {
    DB: db,
    PLATFORM_FEE_ADDRESS: chain.treasuryWallet,
    ESCROW_ADDRESS_BASE_SEPOLIA: chain.escrowAddress,
    ESCROW_TOKEN_ADDRESS_BASE_SEPOLIA: chain.usdcAddress,
    ESCROW_TESTNET_ONLY: "on",
    BASE_SEPOLIA_RPC_URL: chain.rpcUrl,
    SANCTIONS_RPC_URL: chain.rpcUrl,
    SANCTIONS_ORACLE_ADDRESS: chain.oracleAddress,
  };

  const posterReg = await registerAgent(db, "chain-poster", { contact_email: "p@example.com" }, ORIGIN, env);
  const poster = await authByKey(db, posterReg.api_key);
  const fillerReg = await registerAgent(db, "chain-filler", { payout_address: chain.fillerWallet }, ORIGIN, env);
  const filler = await authByKey(db, fillerReg.api_key);

  const created = await postBounty(db, poster, env, {
    title: "Verify chain guard and sanctions check on fund page",
    description: "Check that Base mainnet and Ethereum mainnet are refused while testnet mode is active.",
    category: "research",
    reward_amount_cents: 500,
    settlement: "onchain",
  });
  await acceptBounty(db, filler, created.bounty_id, env);

  const pageHtml = await (
    await worker.fetch(new Request(`${ORIGIN}/bounties/${created.bounty_id}/fund`), env, CTX)
  ).text();
  const workerFetch = (url, init) => worker.fetch(new Request(url, init), env, CTX);

  // 1. Wrong chains in wallet (Base mainnet 0x2105 = 8453, Ethereum mainnet 0x1 = 1, Arbitrum 0xa4b1 = 42161)
  for (const wrongHex of ["0x2105", "0x1", "0xa4b1"]) {
    assert.throws(() => assertAllowedFundingChain(wrongHex, true), /Testnet mode is active/);
    const { provider, sentTransactions } = chain.makeInjectedWallet(chain.posterWallet, wrongHex);
    await assert.rejects(
      () =>
        fundJobFromPage({
          pageHtml,
          origin: ORIGIN,
          ethereum: provider,
          fetchImpl: workerFetch,
        }),
      /Testnet mode is active/,
    );
    assert.equal(sentTransactions.length, 0);

    // Server-side /v1/bounties/:id/fund/prepare also refuses wrong chain_id directly
    const badChainRes = await workerFetch(`${ORIGIN}/v1/bounties/${created.bounty_id}/fund/prepare`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: chain.posterWallet, chain_id: wrongHex }),
    });
    assert.equal(badChainRes.status, 409);
    const badChainJson = await badChainRes.json();
    assert.match(badChainJson.message, /Base Sepolia/);
  }

  // 2. Flagged poster wallet on Base Sepolia is refused neutrally (403) before any transaction is signed
  const { provider: flaggedProvider, sentTransactions: flaggedSent } = chain.makeInjectedWallet(
    chain.flaggedWallet,
  );
  await assert.rejects(
    () =>
      fundJobFromPage({
        pageHtml,
        origin: ORIGIN,
        ethereum: flaggedProvider,
        fetchImpl: workerFetch,
      }),
    /cannot be used on this board/,
  );
  assert.equal(flaggedSent.length, 0);

  // Verify private operator log recorded the block and zero public events leaked it
  const blocks = await db.prepare("SELECT * FROM sanctions_blocks").all();
  assert.equal(blocks.results.length, 1);
  assert.equal(blocks.results[0].address, chain.flaggedWallet.toLowerCase());
  assert.equal(blocks.results[0].context, "poster_fund");
  const pub = await recentActivity(db, 50);
  assert.ok(!JSON.stringify(pub).toLowerCase().includes(chain.flaggedWallet.toLowerCase()));
});
