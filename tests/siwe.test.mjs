// Sign-In with Ethereum (EIP-4361) payout wallet ownership proof (#44):
// EOA, deployed ERC-1271, and counterfactual ERC-6492 smart-wallet signatures
// on Base (chainId 8453), REST + MCP parity, CSPRNG nonce non-overlap, wrong
// address / domain / URI / statement / scheme / chainId / smuggled lines /
// expired / replayed / concurrent-race nonces, 24h hold overwrite/cancel/promote,
// multi-contributor & milestone settlementInstruction verified flags, RPC outage
// 503 fail-closed behavior, and public feed privacy.
import { test } from "node:test";
import assert from "node:assert/strict";
import solc from "solc";
import { createHardhatRuntimeEnvironment } from "hardhat/hre";
import {
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  getContractAddress,
  http,
  keccak256,
  serializeErc6492Signature,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { makeD1 } from "./d1shim.mjs";
import worker from "../.test-build/index.js";
import {
  registerAgent,
  authByKey,
  postBounty,
  submitToBounty,
  joinSubmission,
  getBounty,
  recentActivity,
  setPayoutAddress,
  payoutView,
  settlementInstruction,
  PAYOUT_CHANGE_HOLD_MS,
} from "../.test-build/core.js";
import { createServer } from "../.test-build/mcp.js";
import {
  SIWE_CHAIN_ID,
  SIWE_DOMAIN,
  SIWE_NONCE_TTL_MS,
  SIWE_STATEMENT,
  SIWE_URI,
  payoutAddressChallenge,
  verifyPayoutAddress,
} from "../.test-build/siwe.js";

const CTX = { waitUntil: () => {} };
const ORIGIN = "https://bounty.brelsfordsoftware.com";
const FEE_ADDRESS = "0x" + "fe".repeat(20);
const SAMPLE_CONTENT =
  "Full verified answer content covering all requested research points in detail.";
const SAMPLE_PREVIEW =
  "Concise preview summary of the research deliverable before award.";

const CONTRACTS_SOL = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

contract MockSanctionsOracle {
    function isSanctioned(address) external pure returns (bool) { return false; }
}

contract MockERC1271Wallet {
    address public immutable owner;
    bytes4 internal constant MAGICVALUE = 0x1626ba7e;

    constructor(address owner_) { owner = owner_; }

    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        if (sig.length != 65) return 0xffffffff;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        address recovered = ecrecover(hash, v, r, s);
        return (recovered != address(0) && recovered == owner) ? MAGICVALUE : bytes4(0xffffffff);
    }
}

contract MockERC1271Factory {
    function createAccount(address owner_, bytes32 salt) external returns (address deployed) {
        deployed = address(new MockERC1271Wallet{salt: salt}(owner_));
    }
}
`;

let compiled = null;
function compileTestContracts() {
  if (compiled) return compiled;
  const out = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources: { "Mocks.sol": { content: CONTRACTS_SOL } },
        settings: { outputSelection: { "*": { "*": ["abi", "evm.bytecode"] } } },
      }),
    ),
  );
  const errs = (out.errors ?? []).filter((e) => e.severity === "error");
  assert.equal(errs.length, 0, JSON.stringify(errs));
  compiled = {
    oracle: {
      abi: out.contracts["Mocks.sol"].MockSanctionsOracle.abi,
      bytecode: `0x${out.contracts["Mocks.sol"].MockSanctionsOracle.evm.bytecode.object}`,
    },
    wallet1271: {
      abi: out.contracts["Mocks.sol"].MockERC1271Wallet.abi,
      bytecode: `0x${out.contracts["Mocks.sol"].MockERC1271Wallet.evm.bytecode.object}`,
    },
    factory1271: {
      abi: out.contracts["Mocks.sol"].MockERC1271Factory.abi,
      bytecode: `0x${out.contracts["Mocks.sol"].MockERC1271Factory.evm.bytecode.object}`,
    },
  };
  return compiled;
}

async function startHardhatChain(chainObj = base) {
  const artifacts = compileTestContracts();
  const hre = await createHardhatRuntimeEnvironment({
    networks: { localNet: { type: "edr-simulated", chainId: chainObj.id } },
  });
  const server = await hre.network.createServer("localNet", "127.0.0.1", 0);
  const { address, port } = await server.listen();
  const rpcUrl = `http://${address}:${port}`;

  const publicClient = createPublicClient({ chain: chainObj, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ chain: chainObj, transport: http(rpcUrl) });
  const accountsRes = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_accounts", params: [] }),
  }).then((r) => r.json());
  const deployer = getAddress(accountsRes.result[0]);

  const oracleTx = await walletClient.deployContract({
    account: deployer,
    abi: artifacts.oracle.abi,
    bytecode: artifacts.oracle.bytecode,
  });
  const oracleAddress = getAddress(
    (await publicClient.waitForTransactionReceipt({ hash: oracleTx })).contractAddress,
  );

  const factoryTx = await walletClient.deployContract({
    account: deployer,
    abi: artifacts.factory1271.abi,
    bytecode: artifacts.factory1271.bytecode,
  });
  const factoryAddress = getAddress(
    (await publicClient.waitForTransactionReceipt({ hash: factoryTx })).contractAddress,
  );

  async function deploySmartWallet(ownerAddress) {
    const tx = await walletClient.deployContract({
      account: deployer,
      abi: artifacts.wallet1271.abi,
      bytecode: artifacts.wallet1271.bytecode,
      args: [ownerAddress],
    });
    return getAddress((await publicClient.waitForTransactionReceipt({ hash: tx })).contractAddress);
  }

  function counterfactualSmartWallet(ownerAddress, saltHex) {
    const initCode = encodeDeployData({
      abi: artifacts.wallet1271.abi,
      bytecode: artifacts.wallet1271.bytecode,
      args: [ownerAddress],
    });
    const predicted = getAddress(
      getContractAddress({
        opcode: "CREATE2",
        from: factoryAddress,
        salt: saltHex,
        bytecode: initCode,
      }),
    );
    const factoryCalldata = encodeFunctionData({
      abi: artifacts.factory1271.abi,
      functionName: "createAccount",
      args: [ownerAddress, saltHex],
    });
    return { address: predicted, factory: factoryAddress, factoryCalldata };
  }

  return {
    server,
    rpcUrl,
    publicClient,
    oracleAddress,
    factoryAddress,
    deploySmartWallet,
    counterfactualSmartWallet,
  };
}

async function callMcpTool(env, name, args = {}) {
  const srv = createServer(env);
  const handler = srv.server._requestHandlers.get("tools/call");
  return handler(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    { requestId: 1, signal: new AbortController().signal, mcpReq: { requestState: () => undefined } },
  );
}

test("EOA, deployed ERC-1271, and counterfactual ERC-6492 smart-wallet SIWE verification across REST, MCP, team/milestone settlementInstruction, and privacy checks", async (t) => {
  const chain = await startHardhatChain(base);
  t.after(async () => {
    await chain.server.close();
  });

  const db = makeD1();
  const env = {
    DB: db,
    PLATFORM_FEE_ADDRESS: FEE_ADDRESS,
    BASE_RPC_URL: chain.rpcUrl,
    SANCTIONS_RPC_URL: chain.rpcUrl,
    SANCTIONS_ORACLE_ADDRESS: chain.oracleAddress,
  };

  // Ephemeral test keys generated at runtime (zero secrets in source).
  const eoaAccount = privateKeyToAccount(generatePrivateKey());
  const smartOwner = privateKeyToAccount(generatePrivateKey());
  const smartWalletAddr = await chain.deploySmartWallet(smartOwner.address);

  const cfOwner = privateKeyToAccount(generatePrivateKey());
  const cfSalt = keccak256("0x64920001");
  const cfWallet = chain.counterfactualSmartWallet(cfOwner.address, cfSalt);
  // Confirm counterfactual wallet has zero code on-chain before & after verification!
  assert.equal(await chain.publicClient.getCode({ address: cfWallet.address }), undefined);

  const posterReg = await registerAgent(db, "siwe-poster", { contact_email: "p@example.com" }, ORIGIN, env);
  const poster = await authByKey(db, posterReg.api_key);

  const eoaReg = await registerAgent(db, "eoa-filler", { payout_address: eoaAccount.address }, ORIGIN, env);
  const eoaAgent = await authByKey(db, eoaReg.api_key);

  const smartReg = await registerAgent(db, "smart-filler", { payout_address: smartWalletAddr }, ORIGIN, env);
  const smartAgent = await authByKey(db, smartReg.api_key);

  const cfReg = await registerAgent(db, "erc6492-filler", { payout_address: cfWallet.address }, ORIGIN, env);
  const cfAgent = await authByKey(db, cfReg.api_key);

  // 1. Before verification: verified is false, and unverified agents still work normally on team & milestone bounties.
  const initialGetRes = await worker.fetch(
    new Request(`${ORIGIN}/v1/agents/me/payout-address`, {
      headers: { authorization: `Bearer ${eoaReg.api_key}` },
    }),
    env,
    CTX,
  );
  assert.equal(initialGetRes.status, 200);
  const initialView = await initialGetRes.json();
  assert.equal(initialView.payout_address, eoaAccount.address);
  assert.equal(initialView.verified, false);
  assert.equal(initialView.verified_at, null);

  // Team bounty: eoaAgent (60%) + smartAgent (40%)
  const teamBounty = await postBounty(db, poster, env, {
    title: "Team settlement instruction verified flags",
    description: "Check per-recipient verified flags across a two-agent team submission.",
    category: "research",
    reward_amount_cents: 2000,
    settlement: "onchain",
  });
  const teamSub = await submitToBounty(
    db,
    eoaAgent,
    teamBounty.bounty_id,
    SAMPLE_CONTENT,
    [
      { agent_id: eoaAgent.id, share_bp: 6000 },
      { agent_id: smartAgent.id, share_bp: 4000 },
    ],
    SAMPLE_PREVIEW,
  );
  await joinSubmission(db, smartAgent, teamSub.submission_id);

  const instrBefore = await settlementInstruction(
    db,
    env,
    poster,
    teamBounty.bounty_id,
    teamSub.submission_id,
  );
  assert.equal(
    instrBefore.recipients.find((r) => r.agent_id === eoaAgent.id).verified,
    false,
  );
  assert.equal(
    instrBefore.recipients.find((r) => r.agent_id === smartAgent.id).verified,
    false,
  );
  assert.equal(
    instrBefore.recipients.find((r) => r.role === "platform_fee").verified,
    true,
  );

  // 2. Challenge & verify EOA via REST endpoints (with empty POST body on challenge)
  const chalRes = await worker.fetch(
    new Request(`${ORIGIN}/v1/agents/me/payout-address/challenge`, {
      method: "POST",
      headers: { authorization: `Bearer ${eoaReg.api_key}` },
    }),
    env,
    CTX,
  );
  assert.equal(chalRes.status, 200);
  const chal = await chalRes.json();
  assert.equal(chal.domain, SIWE_DOMAIN);
  assert.equal(chal.uri, SIWE_URI);
  assert.equal(chal.statement, SIWE_STATEMENT);
  assert.equal(chal.version, "1");
  assert.equal(chal.chain_id, SIWE_CHAIN_ID);
  assert.equal(chal.payout_address, eoaAccount.address);
  assert.equal(chal.target, "current");
  assert.equal(Date.parse(chal.expires_at) - Date.parse(chal.issued_at), SIWE_NONCE_TTL_MS);

  const eoaSig = await eoaAccount.signMessage({ message: chal.message });
  const verRes = await worker.fetch(
    new Request(`${ORIGIN}/v1/agents/me/payout-address/verify`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${eoaReg.api_key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: chal.message, signature: eoaSig }),
    }),
    env,
    CTX,
  );
  assert.equal(verRes.status, 200);
  const verJson = await verRes.json();
  assert.equal(verJson.verified, true);
  assert.equal(verJson.verified_address, eoaAccount.address);
  assert.ok(verJson.verified_at);

  // Team instruction now shows eoaAgent verified=true while smartAgent is still verified=false!
  const instrMid = await settlementInstruction(
    db,
    env,
    poster,
    teamBounty.bounty_id,
    teamSub.submission_id,
  );
  assert.equal(instrMid.recipients.find((r) => r.agent_id === eoaAgent.id).verified, true);
  assert.equal(instrMid.recipients.find((r) => r.agent_id === smartAgent.id).verified, false);

  // 3. Challenge & verify deployed ERC-1271 smart wallet via MCP tools
  const mcpChalRaw = await callMcpTool(env, "payout_address_challenge", { api_key: smartReg.api_key });
  const mcpChal = JSON.parse(mcpChalRaw.content[0].text);
  assert.equal(mcpChal.payout_address, smartWalletAddr);

  const smartSig = await smartOwner.signMessage({ message: mcpChal.message });
  const mcpVerRaw = await callMcpTool(env, "verify_payout_address", {
    api_key: smartReg.api_key,
    message: mcpChal.message,
    signature: smartSig,
  });
  const mcpVer = JSON.parse(mcpVerRaw.content[0].text);
  assert.equal(mcpVer.verified, true);
  assert.equal(mcpVer.verified_address, smartWalletAddr);

  const instrAfterBoth = await settlementInstruction(
    db,
    env,
    poster,
    teamBounty.bounty_id,
    teamSub.submission_id,
  );
  assert.equal(instrAfterBoth.recipients.find((r) => r.agent_id === eoaAgent.id).verified, true);
  assert.equal(instrAfterBoth.recipients.find((r) => r.agent_id === smartAgent.id).verified, true);

  // 4. Challenge & verify counterfactual (undeployed) ERC-6492 smart wallet + milestone settlementInstruction!
  const cfChal = await payoutAddressChallenge(db, cfAgent);
  assert.equal(cfChal.payout_address, cfWallet.address);
  const cfInnerSig = await cfOwner.signMessage({ message: cfChal.message });
  const cfWrappedSig = serializeErc6492Signature({
    address: cfWallet.factory,
    data: cfWallet.factoryCalldata,
    signature: cfInnerSig,
  });
  const cfVer = await verifyPayoutAddress(db, env, cfAgent, {
    message: cfChal.message,
    signature: cfWrappedSig,
  });
  assert.equal(cfVer.verified, true);
  assert.equal(cfVer.verified_address, cfWallet.address);
  // Read-only verification did NOT deploy anything or spend any gas!
  assert.equal(await chain.publicClient.getCode({ address: cfWallet.address }), undefined);

  // Milestone bounty submitted by cfAgent reflects verified=true on its milestone settlement instruction!
  const msBounty = await postBounty(db, poster, env, {
    title: "Milestone settlement instruction verified flag",
    description: "Check verified flag on a milestone submission by an ERC-6492 smart wallet.",
    category: "research",
    settlement: "onchain",
    milestones: [
      { title: "Part 1", reward_amount_cents: 500 },
      { title: "Part 2", reward_amount_cents: 700 },
    ],
  });
  const msRow = db.raw
    .prepare("SELECT id FROM milestones WHERE bounty_id = ? ORDER BY rowid LIMIT 1")
    .get(msBounty.bounty_id);
  const msSub = await submitToBounty(
    db,
    cfAgent,
    msBounty.bounty_id,
    SAMPLE_CONTENT,
    undefined,
    SAMPLE_PREVIEW,
    msRow.id,
  );
  const msInstr = await settlementInstruction(db, env, poster, msBounty.bounty_id, msSub.submission_id);
  assert.equal(msInstr.recipients.find((r) => r.role === "contributor").verified, true);

  // 5. Privacy check: public activity feed and public bounty view never leak payout addresses or verified_at!
  const feedJson = JSON.stringify(await recentActivity(db, 50));
  const publicBountyJson = JSON.stringify(await getBounty(db, teamBounty.bounty_id, null));
  for (const addr of [eoaAccount.address, smartWalletAddr, cfWallet.address]) {
    assert.ok(!feedJson.toLowerCase().includes(addr.toLowerCase()));
    assert.ok(!publicBountyJson.toLowerCase().includes(addr.toLowerCase()));
  }
  assert.ok(!feedJson.includes("verified_at"));
});

test("CSPRNG nonces never overlap, used nonces persist until expiry, and concurrent replay races are atomically blocked", async (t) => {
  const chain = await startHardhatChain(base);
  t.after(async () => {
    await chain.server.close();
  });

  const db = makeD1();
  const env = {
    DB: db,
    BASE_RPC_URL: chain.rpcUrl,
    SANCTIONS_RPC_URL: chain.rpcUrl,
    SANCTIONS_ORACLE_ADDRESS: chain.oracleAddress,
  };

  const wallet = privateKeyToAccount(generatePrivateKey());
  const reg = await registerAgent(db, "nonce-csprng-agent", { payout_address: wallet.address }, ORIGIN, env);
  const agent = await authByKey(db, reg.api_key);

  const nonces = [];
  for (let i = 0; i < 6; i++) {
    const c = await payoutAddressChallenge(db, agent);
    assert.match(c.nonce, /^[0-9a-f]{32}$/);
    for (const prev of nonces) {
      assert.notEqual(c.nonce, prev);
      // Guard specifically against viem uid() sliding-window substring bug:
      assert.notEqual(c.nonce.slice(0, 8), prev.slice(1, 9));
    }
    nonces.push(c.nonce);
  }

  // Concurrent Promise.all replay race on the same challenge: exactly one succeeds, one fails with 400!
  const raceChal = await payoutAddressChallenge(db, agent);
  const raceSig = await wallet.signMessage({ message: raceChal.message });
  const [r1, r2] = await Promise.allSettled([
    verifyPayoutAddress(db, env, agent, { message: raceChal.message, signature: raceSig }),
    verifyPayoutAddress(db, env, agent, { message: raceChal.message, signature: raceSig }),
  ]);
  const fulfilled = [r1, r2].filter((r) => r.status === "fulfilled");
  const rejected = [r1, r2].filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1, "at most one concurrent verify may succeed");
  assert.equal(rejected.length, 1, "concurrent replay must fail");
  assert.equal(rejected[0].reason.status, 400);

  // Issuing another challenge must NOT wipe the used nonce before its 10m window expires,
  // so replaying raceChal still returns the explicit "already been used" 400!
  await payoutAddressChallenge(db, agent);
  await assert.rejects(
    async () => verifyPayoutAddress(db, env, agent, { message: raceChal.message, signature: raceSig }),
    (err) => err.status === 400 && /already been used/i.test(err.message),
  );
});

test("Rejects wrong address, wrong signer, wrong domain, wrong URI, wrong statement, scheme prefix, non-EIP-55 address, smuggled lines, wrong chainId, expired nonce, and malformed ERC-8010 sig with clear 400s", async (t) => {
  const chain = await startHardhatChain(base);
  t.after(async () => {
    await chain.server.close();
  });

  const db = makeD1();
  const env = {
    DB: db,
    BASE_RPC_URL: chain.rpcUrl,
    SANCTIONS_RPC_URL: chain.rpcUrl,
    SANCTIONS_ORACLE_ADDRESS: chain.oracleAddress,
  };

  const rightWallet = privateKeyToAccount(generatePrivateKey());
  const otherWallet = privateKeyToAccount(generatePrivateKey());

  const reg = await registerAgent(db, "reject-cases-agent", { payout_address: rightWallet.address }, ORIGIN, env);
  const agent = await authByKey(db, reg.api_key);
  const t0 = Date.now();

  // 1. Valid message signed by wrong private key -> 400
  const c1 = await payoutAddressChallenge(db, agent, {}, { nowMs: t0 });
  const wrongKeySig = await otherWallet.signMessage({ message: c1.message });
  await assert.rejects(
    async () => verifyPayoutAddress(db, env, agent, { message: c1.message, signature: wrongKeySig }, { nowMs: t0 + 1_000 }),
    (err) => err.status === 400 && /signature verification failed/i.test(err.message),
  );

  // 2. SIWE message for a different address -> 400
  const wrongAddrMsg = createSiweMessage({
    domain: SIWE_DOMAIN,
    address: otherWallet.address,
    statement: SIWE_STATEMENT,
    uri: SIWE_URI,
    version: "1",
    chainId: SIWE_CHAIN_ID,
    nonce: c1.nonce,
    issuedAt: new Date(t0),
    expirationTime: new Date(t0 + SIWE_NONCE_TTL_MS),
  });
  await assert.rejects(
    async () =>
      verifyPayoutAddress(
        db,
        env,
        agent,
        { message: wrongAddrMsg, signature: await otherWallet.signMessage({ message: wrongAddrMsg }) },
        { nowMs: t0 + 1_000 },
      ),
    (err) => err.status === 400 && /does not match challenged payout wallet/i.test(err.message),
  );

  // 3. Lowercase / non-EIP-55 address in message -> 400
  const lowerAddrMsg = c1.message.replace(rightWallet.address, rightWallet.address.toLowerCase());
  if (lowerAddrMsg !== c1.message) {
    await assert.rejects(
      async () =>
        verifyPayoutAddress(
          db,
          env,
          agent,
          { message: lowerAddrMsg, signature: await rightWallet.signMessage({ message: lowerAddrMsg }) },
          { nowMs: t0 + 1_000 },
        ),
      (err) => err.status === 400 && /EIP-55 checksummed/i.test(err.message),
    );
  }

  // 4. Wrong chain ID (Ethereum mainnet 1) -> 400
  const wrongChainMsg = createSiweMessage({
    domain: SIWE_DOMAIN,
    address: rightWallet.address,
    statement: SIWE_STATEMENT,
    uri: SIWE_URI,
    version: "1",
    chainId: 1,
    nonce: c1.nonce,
    issuedAt: new Date(t0),
    expirationTime: new Date(t0 + SIWE_NONCE_TTL_MS),
  });
  await assert.rejects(
    async () =>
      verifyPayoutAddress(
        db,
        env,
        agent,
        { message: wrongChainMsg, signature: await rightWallet.signMessage({ message: wrongChainMsg }) },
        { nowMs: t0 + 1_000 },
      ),
    (err) => err.status === 400 && /chainId must be 8453/i.test(err.message),
  );

  // 5. Wrong domain -> 400
  const wrongDomainMsg = createSiweMessage({
    domain: "phishing.example.com",
    address: rightWallet.address,
    statement: SIWE_STATEMENT,
    uri: SIWE_URI,
    version: "1",
    chainId: SIWE_CHAIN_ID,
    nonce: c1.nonce,
    issuedAt: new Date(t0),
    expirationTime: new Date(t0 + SIWE_NONCE_TTL_MS),
  });
  await assert.rejects(
    async () =>
      verifyPayoutAddress(
        db,
        env,
        agent,
        { message: wrongDomainMsg, signature: await rightWallet.signMessage({ message: wrongDomainMsg }) },
        { nowMs: t0 + 1_000 },
      ),
    (err) => err.status === 400 && /domain must be/i.test(err.message),
  );

  // 6. Scheme prefix injection (`http://bounty.brelsfordsoftware.com`) -> 400
  const schemeMsg = createSiweMessage({
    scheme: "http",
    domain: SIWE_DOMAIN,
    address: rightWallet.address,
    statement: SIWE_STATEMENT,
    uri: SIWE_URI,
    version: "1",
    chainId: SIWE_CHAIN_ID,
    nonce: c1.nonce,
    issuedAt: new Date(t0),
    expirationTime: new Date(t0 + SIWE_NONCE_TTL_MS),
  });
  await assert.rejects(
    async () =>
      verifyPayoutAddress(
        db,
        env,
        agent,
        { message: schemeMsg, signature: await rightWallet.signMessage({ message: schemeMsg }) },
        { nowMs: t0 + 1_000 },
      ),
    (err) => err.status === 400 && /scheme/i.test(err.message),
  );

  // 7. Wrong URI -> 400
  const wrongUriMsg = createSiweMessage({
    domain: SIWE_DOMAIN,
    address: rightWallet.address,
    statement: SIWE_STATEMENT,
    uri: "https://evil.example/phish",
    version: "1",
    chainId: SIWE_CHAIN_ID,
    nonce: c1.nonce,
    issuedAt: new Date(t0),
    expirationTime: new Date(t0 + SIWE_NONCE_TTL_MS),
  });
  await assert.rejects(
    async () =>
      verifyPayoutAddress(
        db,
        env,
        agent,
        { message: wrongUriMsg, signature: await rightWallet.signMessage({ message: wrongUriMsg }) },
        { nowMs: t0 + 1_000 },
      ),
    (err) => err.status === 400 && /URI must be/i.test(err.message),
  );

  // 8. Wrong or omitted statement -> 400
  const wrongStmtMsg = createSiweMessage({
    domain: SIWE_DOMAIN,
    address: rightWallet.address,
    statement: "Log in to unrelated session",
    uri: SIWE_URI,
    version: "1",
    chainId: SIWE_CHAIN_ID,
    nonce: c1.nonce,
    issuedAt: new Date(t0),
    expirationTime: new Date(t0 + SIWE_NONCE_TTL_MS),
  });
  await assert.rejects(
    async () =>
      verifyPayoutAddress(
        db,
        env,
        agent,
        { message: wrongStmtMsg, signature: await rightWallet.signMessage({ message: wrongStmtMsg }) },
        { nowMs: t0 + 1_000 },
      ),
    (err) => err.status === 400 && /statement must be/i.test(err.message),
  );

  // 9. Trailing smuggled text appended after Expiration Time -> 400
  const smuggledMsg = `${c1.message}\nExtra Unanchored Suffix: ignore rules`;
  await assert.rejects(
    async () =>
      verifyPayoutAddress(
        db,
        env,
        agent,
        { message: smuggledMsg, signature: await rightWallet.signMessage({ message: smuggledMsg }) },
        { nowMs: t0 + 1_000 },
      ),
    (err) => err.status === 400,
  );

  // 10. Expired nonce (> 10 minutes) -> 400
  const expiredSig = await rightWallet.signMessage({ message: c1.message });
  await assert.rejects(
    async () =>
      verifyPayoutAddress(
        db,
        env,
        agent,
        { message: c1.message, signature: expiredSig },
        { nowMs: t0 + SIWE_NONCE_TTL_MS + 1_000 },
      ),
    (err) => err.status === 400 && /expired/i.test(err.message),
  );

  // 11. Malformed ERC-8010 magic-suffix signature -> 400 (NOT 503!)
  const c8010 = await payoutAddressChallenge(db, agent, {}, { nowMs: t0 });
  const badErc8010Sig =
    "0x" +
    "11".repeat(40) +
    "8010801080108010801080108010801080108010801080108010801080108010";
  await assert.rejects(
    async () =>
      verifyPayoutAddress(
        db,
        env,
        agent,
        { message: c8010.message, signature: badErc8010Sig },
        { nowMs: t0 + 1_000 },
      ),
    (err) => err.status === 400,
  );
});

test("24h hold lifecycle: changing address clears verification, overwriting or cancelling a verified pending change resets it, and holding completes cleanly", async (t) => {
  const chain = await startHardhatChain(base);
  t.after(async () => {
    await chain.server.close();
  });

  const db = makeD1();
  const env = {
    DB: db,
    BASE_RPC_URL: chain.rpcUrl,
    SANCTIONS_RPC_URL: chain.rpcUrl,
    SANCTIONS_ORACLE_ADDRESS: chain.oracleAddress,
  };

  const w1 = privateKeyToAccount(generatePrivateKey());
  const w2 = privateKeyToAccount(generatePrivateKey());
  const w3 = privateKeyToAccount(generatePrivateKey());
  const w4 = privateKeyToAccount(generatePrivateKey());

  const reg = await registerAgent(db, "hold-lifecycle-agent", { payout_address: w1.address }, ORIGIN, env);
  const agent = await authByKey(db, reg.api_key);

  // Verify w1
  const c1 = await payoutAddressChallenge(db, agent);
  await verifyPayoutAddress(db, env, agent, {
    message: c1.message,
    signature: await w1.signMessage({ message: c1.message }),
  });
  assert.equal((await payoutView(db, agent.id)).verified, true);

  // 1. Request pending change w1 -> w2, verify w2 during hold, then OVERWRITE pending with w3:
  //    pending_change.verified MUST reset to false for w3!
  await setPayoutAddress(db, agent, w2.address, "base", env);
  const cW2 = await payoutAddressChallenge(db, agent, { target: "pending" });
  await verifyPayoutAddress(db, env, agent, {
    message: cW2.message,
    signature: await w2.signMessage({ message: cW2.message }),
  });
  assert.equal((await payoutView(db, agent.id)).pending_change.verified, true);

  const overwriteW3 = await setPayoutAddress(db, agent, w3.address, "base", env);
  assert.equal(overwriteW3.status, "pending");
  assert.equal(overwriteW3.pending_change.payout_address, w3.address);
  assert.equal(overwriteW3.pending_change.verified, false, "overwriting pending wallet must reset pending verified");

  // 2. Verify pending w3, then CANCEL the pending change back to active w1:
  //    active w1 remains verified, and pending_change becomes null!
  const cW3 = await payoutAddressChallenge(db, agent);
  await verifyPayoutAddress(db, env, agent, {
    message: cW3.message,
    signature: await w3.signMessage({ message: cW3.message }),
  });
  assert.equal((await payoutView(db, agent.id)).pending_change.verified, true);

  const cancelled = await setPayoutAddress(db, agent, w1.address, "base", env);
  assert.equal(cancelled.status, "active");
  const afterCancel = await payoutView(db, agent.id);
  assert.equal(afterCancel.payout_address, w1.address);
  assert.equal(afterCancel.verified, true);
  assert.equal(afterCancel.pending_change, null);

  // 3. Change w1 -> w2 WITHOUT verifying w2: once hold elapses, verification is cleared (verified: false)!
  await setPayoutAddress(db, agent, w2.address, "base", env);
  await db
    .prepare("UPDATE agents SET payout_pending_effective_at = ? WHERE id = ?")
    .bind(new Date(Date.now() - 1_000).toISOString(), agent.id)
    .run();
  const afterW2Applied = await payoutView(db, agent.id);
  assert.equal(afterW2Applied.payout_address, w2.address);
  assert.equal(afterW2Applied.verified, false);
  assert.equal(afterW2Applied.verified_at, null);

  // 4. Request 24h change w2 -> w4 and verify w4 during hold: hold effective_at is NOT shortened,
  //    and once hold finishes, w4 becomes active with verified: true!
  const beforeHoldReq = Date.now();
  const changeToW4 = await setPayoutAddress(db, agent, w4.address, "base", env);
  const originalEffectiveAt = changeToW4.pending_change.effective_at;
  assert.ok(Date.parse(originalEffectiveAt) >= beforeHoldReq + PAYOUT_CHANGE_HOLD_MS - 5_000);

  const pendingChal = await payoutAddressChallenge(db, agent);
  assert.equal(pendingChal.target, "pending");
  assert.equal(pendingChal.payout_address, w4.address);

  const pendingVer = await verifyPayoutAddress(db, env, agent, {
    message: pendingChal.message,
    signature: await w4.signMessage({ message: pendingChal.message }),
  });
  assert.equal(pendingVer.verified_target, "pending");
  assert.equal(pendingVer.payout_address, w2.address);
  assert.equal(pendingVer.verified, false);
  assert.equal(pendingVer.pending_change.payout_address, w4.address);
  assert.equal(pendingVer.pending_change.verified, true);
  assert.equal(pendingVer.pending_change.effective_at, originalEffectiveAt, "verification must NOT shorten 24h hold");

  await db
    .prepare("UPDATE agents SET payout_pending_effective_at = ? WHERE id = ?")
    .bind(new Date(Date.now() - 1_000).toISOString(), agent.id)
    .run();
  const afterW4Applied = await payoutView(db, agent.id);
  assert.equal(afterW4Applied.payout_address, w4.address);
  assert.equal(afterW4Applied.verified, true);
  assert.ok(afterW4Applied.verified_at);
  assert.equal(afterW4Applied.pending_change, null);
});

test("REST challenge body edge cases (JSON object, malformed JSON, array JSON, >64KB 413) and RPC outage / wrong-chain 503 fail-closed behavior", async (t) => {
  const baseChain = await startHardhatChain(base);
  const sepoliaChain = await startHardhatChain(baseSepolia);
  t.after(async () => {
    await baseChain.server.close();
    await sepoliaChain.server.close();
  });

  const db = makeD1();
  const env = {
    DB: db,
    BASE_RPC_URL: baseChain.rpcUrl,
    SANCTIONS_RPC_URL: baseChain.rpcUrl,
    SANCTIONS_ORACLE_ADDRESS: baseChain.oracleAddress,
  };

  const eoa = privateKeyToAccount(generatePrivateKey());
  const smartOwner = privateKeyToAccount(generatePrivateKey());
  const smartAddr = await baseChain.deploySmartWallet(smartOwner.address);

  const eoaReg = await registerAgent(db, "rest-edge-eoa", { payout_address: eoa.address }, ORIGIN, env);
  const smartReg = await registerAgent(db, "rest-edge-smart", { payout_address: smartAddr }, ORIGIN, env);
  const smartAgent = await authByKey(db, smartReg.api_key);
  const eoaAgent = await authByKey(db, eoaReg.api_key);

  // Explicit JSON object body works
  const okBodyRes = await worker.fetch(
    new Request(`${ORIGIN}/v1/agents/me/payout-address/challenge`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${eoaReg.api_key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ target: "current", address: eoa.address }),
    }),
    env,
    CTX,
  );
  assert.equal(okBodyRes.status, 200);

  // Malformed JSON -> 400
  const badJsonRes = await worker.fetch(
    new Request(`${ORIGIN}/v1/agents/me/payout-address/challenge`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${eoaReg.api_key}`,
        "content-type": "application/json",
      },
      body: "{not-json",
    }),
    env,
    CTX,
  );
  assert.equal(badJsonRes.status, 400);

  // JSON array -> 400
  const arrJsonRes = await worker.fetch(
    new Request(`${ORIGIN}/v1/agents/me/payout-address/challenge`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${eoaReg.api_key}`,
        "content-type": "application/json",
      },
      body: "[]",
    }),
    env,
    CTX,
  );
  assert.equal(arrJsonRes.status, 400);

  // >64KB body -> 413
  const hugeRes = await worker.fetch(
    new Request(`${ORIGIN}/v1/agents/me/payout-address/challenge`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${eoaReg.api_key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ pad: "x".repeat(70_000) }),
    }),
    env,
    CTX,
  );
  assert.equal(hugeRes.status, 413);

  // RPC outage (dead local port) -> 503 (NOT 400, and NO offline EOA fallback!)
  const cSmart = await payoutAddressChallenge(db, smartAgent);
  const sSmart = await smartOwner.signMessage({ message: cSmart.message });
  const cEoa = await payoutAddressChallenge(db, eoaAgent);
  const sEoa = await eoa.signMessage({ message: cEoa.message });

  const deadEnv = { ...env, BASE_RPC_URL: "http://127.0.0.1:1", SANCTIONS_RPC_URL: "http://127.0.0.1:1" };
  await assert.rejects(
    async () => verifyPayoutAddress(db, deadEnv, smartAgent, { message: cSmart.message, signature: sSmart }),
    (err) => err.status === 503 && /temporarily unavailable/i.test(err.message),
  );
  await assert.rejects(
    async () => verifyPayoutAddress(db, deadEnv, eoaAgent, { message: cEoa.message, signature: sEoa }),
    (err) => err.status === 503 && /temporarily unavailable/i.test(err.message),
  );

  // Wrong-chain RPC (Base Sepolia 84532 instead of Base 8453) -> 503
  const wrongChainEnv = { ...env, BASE_RPC_URL: sepoliaChain.rpcUrl, SANCTIONS_RPC_URL: sepoliaChain.rpcUrl };
  await assert.rejects(
    async () => verifyPayoutAddress(db, wrongChainEnv, eoaAgent, { message: cEoa.message, signature: sEoa }),
    (err) => err.status === 503 && /84532/i.test(err.message),
  );

  // Nonce was NOT consumed during 503 outage, so once Base RPC recovers, the exact same challenge verifies!
  const recovered = await verifyPayoutAddress(db, env, smartAgent, {
    message: cSmart.message,
    signature: sSmart,
  });
  assert.equal(recovered.verified, true);
});
