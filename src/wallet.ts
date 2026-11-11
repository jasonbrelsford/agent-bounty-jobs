/**
 * Payout wallet checks. PURE — no database, no network, no key material.
 *
 * A payout address is the one piece of data on this board where a typo or a
 * swap loses real money with no way back: posters pay it directly and the
 * board cannot recall a transfer. So the checks here are deliberately strict,
 * and the EIP-55 checksum is verified whenever the caller gave one, because a
 * mixed-case address that fails its checksum is almost always a mistyped one.
 */

/** Chains a payout address may be recorded for. USDC on Base only, for now. */
export const PAYOUT_CHAINS = ["base"] as const;
export type PayoutChain = (typeof PAYOUT_CHAINS)[number];

/** Circle's native USDC on Base. Not a wallet: funds sent to it are lost. */
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

/** Addresses nobody controls. Money sent here is burned. */
const UNSPENDABLE = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
  "0xdead000000000000000042069420694206942069",
]);

// ── keccak-256 (the Ethereum variant, NOT NIST SHA3-256) ────────────────────
// Small and slow on purpose: it hashes a 40-character string a handful of
// times per request. Checked against published vectors in tests/wallet.test.mjs.

const M64 = (1n << 64n) - 1n;
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
/** Rotation offsets, indexed x + 5y. */
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];

const rotl = (v: bigint, n: number) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & M64);

function keccakF(s: bigint[]) {
  const c = new Array<bigint>(5);
  const b = new Array<bigint>(25);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) c[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
    }
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x + 5 * y]);
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 25; y += 5) s[x + y] = b[x + y] ^ ((b[((x + 1) % 5) + y] ^ M64) & b[((x + 2) % 5) + y]);
    s[0] ^= RC[round];
  }
}

export function keccak256(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const rate = 136;
  const padded = new Uint8Array(bytes.length + (rate - (bytes.length % rate)));
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const s = new Array<bigint>(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + k]);
      s[i] ^= lane;
    }
    keccakF(s);
  }
  let hex = "";
  for (let i = 0; i < 4; i++)
    for (let k = 0; k < 8; k++) hex += Number((s[i] >> BigInt(8 * k)) & 0xffn).toString(16).padStart(2, "0");
  return hex;
}

/** EIP-55 mixed-case form of a 0x address. */
export function toChecksumAddress(addr: string): string {
  const lower = addr.toLowerCase().replace(/^0x/, "");
  const hash = keccak256(lower);
  let out = "0x";
  for (let i = 0; i < 40; i++) out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}

export type PayoutCheck =
  | { ok: true; address: string; checksum_address: string; chain: PayoutChain; checksum_verified: boolean }
  | { ok: false; error: string };

/**
 * Validate a payout address for a chain. Returns the lower-case address to
 * store, plus the checksummed form to show back so the owner can compare it
 * with their wallet app character by character.
 */
export function checkPayoutAddress(raw: unknown, chainRaw: unknown = "base"): PayoutCheck {
  const chain = String(chainRaw ?? "base").trim().toLowerCase() || "base";
  if (!(PAYOUT_CHAINS as readonly string[]).includes(chain))
    return {
      ok: false,
      error: `payout_chain must be one of: ${PAYOUT_CHAINS.join(", ")}. This board pays USDC on Base only — an address on another network would not receive it.`,
    };
  const addr = String(raw ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr))
    return { ok: false, error: "payout_address must be a 0x-prefixed 40-hex-character address on Base (an EVM wallet address)" };
  const lower = addr.toLowerCase();
  if (UNSPENDABLE.has(lower))
    return { ok: false, error: "that is a burn address nobody controls — USDC sent there is destroyed. Use your own wallet's address." };
  if (lower === USDC_BASE)
    return { ok: false, error: "that is the USDC token contract itself, not a wallet. Use your own wallet's address." };
  const body = addr.slice(2);
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  const checksum = toChecksumAddress(lower);
  if (mixed && checksum !== addr)
    return {
      ok: false,
      error: "that address fails its EIP-55 checksum, which usually means a character was mistyped. Copy it again from your wallet.",
    };
  return { ok: true, address: lower, checksum_address: checksum, chain: chain as PayoutChain, checksum_verified: mixed };
}
