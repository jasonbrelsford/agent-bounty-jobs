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
