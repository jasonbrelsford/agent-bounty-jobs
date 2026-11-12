/**
 * Base chain verification. READ ONLY — this module can fetch and parse, and has
 * no key material and no way to move a cent. That is deliberate and load-bearing:
 * the board verifies payments it did not make and cannot make, which is what
 * keeps it out of the custody path.
 */
import { OpError, USDC_BASE, MIN_CONFIRMATIONS } from "./core.js";

/** keccak256("Transfer(address,address,uint256)") */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export type Transfer = { from: string; to: string; units: bigint; logIndex: number };
export type TxRead = { transfers: Transfer[]; blockTime: number };

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new OpError(502, `chain RPC returned ${res.status}`);
  const j = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (j.error) throw new OpError(502, `chain RPC error: ${j.error.message ?? "unknown"}`);
  return j.result;
}

const hexToBigInt = (h: string) => BigInt(h === "0x" ? "0x0" : h);
/** Topics are 32-byte left-padded; an address is the low 20 bytes. */
const topicToAddress = (t: string) => `0x${t.slice(-40)}`.toLowerCase();

export function isAddress(v: unknown): v is string {
  return typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
}
export function isTxHash(v: unknown): v is string {
  return typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
}

/**
 * Fetch a transaction and return every USDC transfer it contains.
 *
 * Throws rather than returning empty on anything suspicious. A caller that gets
 * a list back knows the transaction succeeded, is buried deep enough, and that
 * these transfers were emitted by the real USDC contract.
 */
export async function usdcTransfers(rpcUrl: string, txHash: string): Promise<TxRead> {
  const receipt = (await rpc(rpcUrl, "eth_getTransactionReceipt", [txHash])) as {
    status?: string; blockNumber?: string; logs?: { address: string; topics: string[]; data: string; logIndex?: string }[];
  } | null;
  if (!receipt) throw new OpError(404, "transaction not found on Base — is it mined, and is the hash right?");
  if (receipt.status !== "0x1") throw new OpError(400, "that transaction reverted on-chain; nothing was transferred");

  const head = hexToBigInt((await rpc(rpcUrl, "eth_blockNumber", [])) as string);
  const mined = hexToBigInt(receipt.blockNumber ?? "0x0");
  const confirmations = head >= mined ? head - mined + 1n : 0n;
  if (confirmations < BigInt(MIN_CONFIRMATIONS))
    throw new OpError(
      409,
      `transaction has ${confirmations} confirmation(s); ${MIN_CONFIRMATIONS} required before the deliverable is released. Try again shortly.`,
    );

  // When the block was produced. A payment made before its instruction existed
  // cannot be the payment for it, so an unreadable timestamp is a refusal.
  const block = (await rpc(rpcUrl, "eth_getBlockByNumber", [receipt.blockNumber, false])) as { timestamp?: string } | null;
  const blockTime = block?.timestamp ? Number(hexToBigInt(block.timestamp)) : NaN;
  if (!Number.isSafeInteger(blockTime) || blockTime <= 0)
    throw new OpError(502, "could not read the block time for that transaction; try again shortly");

  return { transfers: parseTransferLogs(receipt.logs ?? []), blockTime };
}

/**
 * Decode USDC Transfer logs from a receipt. Pure, so it can be tested without a
 * chain — this is where a silent bug would misread an AMOUNT, which is the most
 * expensive kind of mistake available here.
 *
 * Filters hard on the USDC contract address and the Transfer topic: a log from
 * any other token, or any other event, is not a payment we accept.
 */
export function parseTransferLogs(
  logs: { address: string; topics: string[]; data: string; logIndex?: string }[],
): Transfer[] {
  return logs
    // The position in the block identifies one transfer for good. Receipts from a
    // node carry it; without it (hand-built logs) the position in the list stands in.
    .map((l, i) => ({ ...l, logIndex: l.logIndex ? Number(hexToBigInt(l.logIndex)) : i }))
    .filter(
      (l) =>
        l.address.toLowerCase() === USDC_BASE &&
        l.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
        l.topics.length >= 3,
    )
    .map((l) => ({
      from: topicToAddress(l.topics[1]),
      to: topicToAddress(l.topics[2]),
      units: hexToBigInt(l.data),
      logIndex: l.logIndex,
    }));
}
