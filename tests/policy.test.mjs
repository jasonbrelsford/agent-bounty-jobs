// Acceptable-use tripwires and the payout split. These are the two places where
// a silent regression is expensive: one lets prohibited work onto the board, the
// other misallocates money. Both are pure functions, so they test cheaply.
import { test } from "node:test";
import assert from "node:assert/strict";
import { violatesHumanPolicy, splitPayout } from "../.test-build/core.js";

// Phrasings a poster would plausibly use for work an agent is barred from doing
// and would like a human to do instead. Hiring it out does not launder it.
const MUST_BLOCK = [
  "Solve CAPTCHAs for our signup flow", "solve captchas", "a captcha farm",
  "recaptcha solving at volume", "hcaptcha batch",
  "bypass the verification step for us", "complete the 2FA challenge",
  "pass the MFA prompt", "bypass KYC", "defeat the challenge",
  "defeat their anti-bot checks", "bot-detection workaround needed",
  "We need identity verification passed", "verify my identity with the bank",
  "pose as the account holder", "pretend to be a customer",
  "impersonate the billing contact", "sign up as me on the portal",
  "open an account on our behalf", "log into my account and export data",
  "log in to their account for us", "provide proof of address",
];

// Legitimate human work — things an agent genuinely cannot do. False positives
// here are not harmless: they reject honest jobs and teach posters to paraphrase,
// which is worse than not having a tripwire.
const MUST_ALLOW = [
  "Photograph a storefront in Lisbon and note opening hours",
  "Transcribe a handwritten archive page OCR cannot read",
  "Call three suppliers and record their quoted lead times",
  "Visit a trade show booth and collect the product spec sheet",
  "Taste-test and rank five coffee samples, write tasting notes",
  "Review our onboarding copy for tone and clarity",
  "Verify these citations point at real published papers",
  "Check whether this shop still stocks the part, in person",
  "Proofread a 20-page technical manual for typos",
  "Identify the bird species in these twelve field photographs",
  "Attend a public meeting and summarise what was decided",
  "Compare in-store prices across three supermarkets",
  "Sign the completed inspection form and return it",
  "Open a support ticket describing the defect",
];

test("human tripwire blocks work an agent may not hire out", () => {
  for (const t of MUST_BLOCK) assert.ok(violatesHumanPolicy(t), `should block: ${t}`);
});

test("human tripwire allows legitimate human work", () => {
  for (const t of MUST_ALLOW) assert.ok(!violatesHumanPolicy(t), `should allow: ${t}`);
});

test("splitPayout conserves every cent", () => {
  const cases = [
    [100, [10000]], [100, [5000, 5000]], [100, [3333, 3333, 3334]],
    [1, [10000]], [7, [3333, 3333, 3334]], [16, Array(16).fill(625)],
    [12345, [1111, 2222, 3333, 3334]], [1000000, Array(16).fill(625)],
  ];
  for (const [cents, shares] of cases) {
    const p = splitPayout(cents, shares);
    assert.equal(p.reduce((a, b) => a + b, 0), cents, `sum must equal ${cents}`);
    assert.ok(p.every(Number.isInteger), "payouts must be integers");
  }
});

test("splitPayout conserves cents across randomized splits", () => {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 3000; i++) {
    const n = 1 + Math.floor(rnd() * 16);
    const raw = Array.from({ length: n }, () => 1 + Math.floor(rnd() * 1000));
    const tot = raw.reduce((a, b) => a + b, 0);
    const sh = raw.map((v) => Math.floor((v * 10000) / tot));
    sh[0] += 10000 - sh.reduce((a, b) => a + b, 0);
    if (sh.some((v) => v <= 0)) continue;
    const cents = 1 + Math.floor(rnd() * 2000000);
    assert.equal(splitPayout(cents, sh).reduce((a, b) => a + b, 0), cents);
  }
});

import { validateEvidenceSpec, validateEvidence, metresBetween, evidenceManifest } from "../.test-build/core.js";

const SPEC = validateEvidenceSpec([
  { kind: "photo", label: "Storefront", min: 2, require_geo: true,
    near: { lat: 38.7223, lon: -9.1393, radius_m: 150 } },
  { kind: "receipt", label: "Purchase receipt", fields: ["vendor", "reference"] },
  { kind: "url", label: "Published review", starts_with: "https://example.com/" },
]);
const photo = (lat, lon) => ({ kind: "photo", label: "Storefront", value: { url: "https://i/x.jpg", geo: { lat, lon } } });
const receipt = { kind: "receipt", label: "Purchase receipt", value: { vendor: "Acme", reference: "R-1" } };
const review = { kind: "url", label: "Published review", value: { url: "https://example.com/r/1" } };
const full = () => [photo(38.7223, -9.1393), photo(38.7224, -9.1394), receipt, review];

test("evidence spec rejects malformed requirements", () => {
  assert.throws(() => validateEvidenceSpec([{ kind: "nope", label: "x" }]), /evidence kind/);
  assert.throws(() => validateEvidenceSpec([{ kind: "photo", label: "ab" }]), /label/);
  assert.throws(() => validateEvidenceSpec([{ kind: "photo", label: "Shop", min: 0 }]), /min/);
  assert.throws(() => validateEvidenceSpec([{ kind: "photo", label: "Shop", near: { lat: 999, lon: 0, radius_m: 5 } }]), /lat/);
});

test("proximity requirement implies a geo requirement", () => {
  assert.equal(validateEvidenceSpec([{ kind: "photo", label: "Shop", near: { lat: 1, lon: 1, radius_m: 10 } }])[0].require_geo, true);
});

test("evidence must satisfy counts, fields, matchers and geo", () => {
  assert.equal(validateEvidence(SPEC, full()).length, 4);
  assert.throws(() => validateEvidence(SPEC, [photo(38.7223, -9.1393), receipt, review]), /requires 2/);
  assert.throws(() => validateEvidence(SPEC, [...full().slice(0, 2), { kind: "receipt", label: "Purchase receipt", value: { vendor: "Acme" } }, review]), /reference/);
  assert.throws(() => validateEvidence(SPEC, [...full().slice(0, 3), { kind: "url", label: "Published review", value: { url: "https://elsewhere.com/x" } }]), /must start with/);
  assert.throws(() => validateEvidence(SPEC, [...full().slice(0, 3), { kind: "url", label: "Published review", value: { url: "http://example.com/r/1" } }]), /https/);
  assert.throws(() => validateEvidence(SPEC, [{ kind: "photo", label: "Nope", value: { url: "https://i/x.jpg" } }]), /does not match any requirement/);
  assert.throws(() => validateEvidence(SPEC, [{ kind: "photo", label: "Storefront", value: { url: "https://i/x.jpg" } }, ...full().slice(1)]), /geo/);
});

test("a far coordinate is recorded non-compliant, not rejected", () => {
  // The coordinate is a CLAIM. Wrong claim with right work is the poster's call.
  const out = validateEvidence(SPEC, [photo(38.7223, -9.1393), photo(0, 0), receipt, review]);
  assert.equal(out.filter((e) => e.compliant === false).length, 1);
  assert.equal(out.filter((e) => e.compliant === true).length, 3);
});

test("a bounty asking for nothing accepts nothing", () => {
  assert.deepEqual(validateEvidence([], []), []);
  assert.throws(() => validateEvidence([], [review]), /does not ask for evidence/);
});

test("manifest exposes shape and compliance but never values", () => {
  const rows = [
    { kind: "photo", label: "Storefront", value: JSON.stringify({ url: "https://secret/x.jpg" }), provenance: "self_reported", compliant: 1 },
    { kind: "photo", label: "Storefront", value: JSON.stringify({ url: "https://secret/y.jpg" }), provenance: "self_reported", compliant: 0 },
  ];
  const m = evidenceManifest(rows);
  assert.equal(m.length, 1);
  assert.equal(m[0].count, 2);
  assert.equal(m[0].all_compliant, false);
  assert.ok(!JSON.stringify(m).includes("secret"), "manifest must not leak values");
});

test("metresBetween is sane", () => {
  assert.ok(metresBetween(38.7223, -9.1393, 38.7223, -9.1393) < 1);
  const d = metresBetween(38.7223, -9.1393, 38.7323, -9.1393);
  assert.ok(d > 1000 && d < 1200, `~1.11km, got ${d}`);
});
