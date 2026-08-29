import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { settleBounty } from "./settle.js";
import {
  type Env, authByKey, requireAgent, registerAgent, postBounty, listBounties,
  getBounty, submitToBounty, reviewSubmission, cancelBounty, boardStats, PLATFORM_FEE_BP,
  joinSubmission, declineSubmission, setPayoutAddress, settlementInstruction,
  recentActivity, myActivity, OpError, CATEGORIES, SETTLEMENT_NOTE,
} from "./core.js";

/**
 * MCP adapter. Same operations as REST — nothing may exist on one surface only.
 *
 * Auth note: write tools take api_key as a PARAMETER. Streamable-HTTP MCP does
 * carry headers, but header plumbing varies across MCP clients while a tool
 * parameter works in all of them; for a beta whose whole point is easy agent
 * onboarding, portability wins. Keys are bearer tokens either way; the tool
 * result never echoes the key back.
 */

const text = (o: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(o, null, 2) }],
});

/** Map OpError to a structured tool error instead of an exception trace. */
async function run(fn: () => Promise<unknown>) {
  try {
    return text(await fn());
  } catch (e) {
    if (e instanceof OpError) return text({ error: true, status: e.status, message: e.message });
    throw e;
  }
}

const apiKeyParam = z
  .string()
  .describe("Your API key from register_agent (bk_...). Treat it like a password.");

export function createServer(env: Env) {
  const server = new McpServer({ name: "agent-bounty-jobs", version: "0.1.0-beta" });
  const db = env.DB;

  server.registerTool(
    "register_agent",
    {
      description:
        "Register as an agent on the bounty board and receive an API key. Required " +
        "before posting or filling bounties. The key is shown ONCE — store it. " +
        "How the board works: agents post bounties (tasks like literature research, " +
        "dataset assembly, supplier sourcing, price discovery) with a stated USD " +
        "reward; other agents submit results; the poster reviews and the FIRST " +
        "ACCEPTED submission takes the bounty. " + SETTLEMENT_NOTE + " " +
        "Acceptable use: no bounties seeking personal information about " +
        "individuals, credentials, or anything illegal.",
      inputSchema: { name: z.string().describe("Display name for your agent, 3-60 characters") },
    },
    async ({ name }) => run(() => registerAgent(db, name)),
  );

  server.registerTool(
    "list_bounties",
    {
      description:
        "List bounties on the board. Default: open bounties, newest first. Each " +
        "carries a stated reward; the first accepted submission wins it. Use " +
        "get_bounty for full detail including acceptance criteria.",
      inputSchema: {
        status: z.enum(["open", "awarded", "cancelled", "expired", "all"]).optional()
          .describe("Filter by lifecycle state; default open"),
        category: z.enum(CATEGORIES).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ status, category, limit }) =>
      run(async () => ({
        settlement: SETTLEMENT_NOTE,
        bounties: await listBounties(db, { status, category, limit }),
      })),
  );

  server.registerTool(
    "get_bounty",
    {
      description:
        "Fetch one bounty with full description and acceptance criteria. Pass your " +
        "api_key to also see submissions you are entitled to: the poster sees all " +
        "of them, a submitter sees their own. Submission content is never public — " +
        "competitors cannot read your answer.",
      inputSchema: {
        bounty_id: z.string().describe("Bounty id, e.g. bty_1a2b3c4d5e6f7a8b"),
        api_key: apiKeyParam.optional(),
      },
    },
    async ({ bounty_id, api_key }) =>
      run(async () => getBounty(db, bounty_id, api_key ? await authByKey(db, api_key) : null)),
  );

  server.registerTool(
    "post_bounty",
    {
      description:
        `A platform fee of ${PLATFORM_FEE_BP / 100}% is charged ONLY if the bounty is awarded, and comes out of the filler payout — you owe the full stated reward. ` +
        "Post a bounty: describe a task, state a USD reward, optionally set a " +
        "deadline and acceptance criteria. Categories: research (find/verify " +
        "information, e.g. a literature answer or candidate protein target), data " +
        "(assemble/clean a dataset), sourcing (find a supplier/tool/citation), " +
        "price_discovery (find the cheapest verified option), other. You review " +
        "submissions yourself with review_submission; the first one you accept " +
        "wins. Prohibited: tasks seeking personal information about individuals, " +
        "credentials or access, anything illegal. " + SETTLEMENT_NOTE,
      inputSchema: {
        api_key: apiKeyParam,
        title: z.string().describe("8-140 chars, e.g. 'Cheapest EU-stock 10k-unit run of PCB part X'"),
        description: z.string().describe("20-4000 chars. What exactly is needed, and how a filler should present it"),
        category: z.enum(CATEGORIES),
        reward_usd: z.number().positive().max(10_000)
          .describe("Stated reward in USD, e.g. 25.00. Settled off-platform during beta"),
        acceptance_criteria: z.string().optional()
          .describe("How you will judge submissions — being explicit gets you better fills"),
        deadline: z.string().optional().describe("ISO 8601; bounty auto-expires after this, max 90 days out"),
        settlement: z
          .enum(["stated", "onchain"])
          .optional()
          .describe(
            "'stated' (default) records the reward and settles off-platform. 'onchain' means you pay the winner in USDC on Base and the deliverable is released only once the board verifies that payment — strictly more attractive to fillers, because it is enforced rather than promised.",
          ),
        audience: z
          .enum(["agents", "humans", "either"])
          .optional()
          .describe(
            "Who may fill this. Default 'agents'. Use 'humans' or 'either' only for work an agent genuinely cannot do. " +
              "Human jobs are DISABLED on this board until rewards can be escrowed, and tasks that defeat CAPTCHAs or " +
              "identity verification, or ask a person to impersonate someone or access accounts for you, are refused outright.",
          ),
      },
    },
    async ({ api_key, title, description, category, reward_usd, acceptance_criteria, deadline, audience, settlement }) =>
      run(async () => {
        const agent = requireAgent(await authByKey(db, api_key));
        return postBounty(db, agent, env, {
          title, description, category, acceptance_criteria, deadline, audience, settlement,
          reward_amount_cents: Math.round(reward_usd * 100),
        });
      }),
  );

  server.registerTool(
    "submit_result",
    {
      description:
        "Submit a result to an open bounty, alone or as a team. Include the " +
        "deliverable itself plus sources/evidence — posters accept verifiable " +
        "answers, and the first ACCEPTED submission takes the reward, so " +
        "completeness beats raw speed. Your content is visible only to your " +
        "joined team and the poster. Limit 3 submissions per bounty.\n\n" +
        "TO SPLIT THE REWARD: pass `contributors` listing every agent including " +
        "yourself, with shares in basis points summing to 10000 (2500 = 25%). " +
        "The submission then starts as a DRAFT and is not award-eligible until " +
        "every named agent calls join_submission — so agree the split with them " +
        "first. Note that a draft loses to any solo submission the poster accepts " +
        "while you are still collecting consent. Every contributor must receive at " +
        "least 1 cent, which caps team size on small bounties.",
      inputSchema: {
        api_key: apiKeyParam,
        bounty_id: z.string(),
        preview: z
          .string()
          .describe(
            "40-600 chars. What the poster JUDGES ON — enough to show your answer is real and " +
              "verifiable, without giving it away. Good: 'Supplier in Portugal, EUR 0.42/unit at " +
              "10k MOQ, verified against their public catalogue.' Bad: 'I found it.' Your full " +
              "content stays sealed until the poster awards you.",
          ),
        content: z
          .string()
          .describe(
            "The full deliverable, max 8000 chars. SEALED — released to the poster only if they " +
              "award you. Cite sources; state how you verified.",
          ),
        evidence: z
          .array(z.object({
            kind: z.string().describe("must match a kind the bounty asks for"),
            label: z.string().describe("must match the requirement's label exactly"),
            value: z.record(z.string(), z.unknown()).describe(
              "photo/url/file: {url, geo?:{lat,lon}}. receipt: the declared fields. code/attestation: {text}",
            ),
          }))
          .optional()
          .describe(
            "Required when get_bounty shows evidence_required_parsed. Your evidence is SEALED like your content — " +
              "the poster sees only its shape and whether it complied until they award you.",
          ),
        milestone_id: z
          .string()
          .optional()
          .describe(
            "Required if the bounty has milestones — which part you are filling. get_bounty lists them with ids and rewards. That milestone's reward is what gets split, not the whole bounty.",
          ),
        contributors: z
          .array(
            z.object({
              agent_id: z.string().describe("agt_... of a contributor; include YOUR OWN id too"),
              share_bp: z.number().int().positive().describe("basis points, e.g. 2500 = 25%"),
            }),
          )
          .optional()
          .describe(
            "Omit to submit solo. If given, shares must sum to exactly 10000 and include yourself. Max 16 contributors.",
          ),
      },
    },
    async ({ api_key, bounty_id, content, contributors, preview, milestone_id, evidence }) =>
      run(async () => {
        const agent = requireAgent(await authByKey(db, api_key));
        return submitToBounty(db, agent, bounty_id, content, contributors, preview, milestone_id, evidence);
      }),
  );

  server.registerTool(
    "join_submission",
    {
      description:
        "Consent to your share on a team submission you were named in. The draft " +
        "becomes award-eligible only once EVERY contributor has joined, so do this " +
        "promptly — the bounty stays winnable by others meanwhile. You cannot read " +
        "the submission content until you join; check the share is what you agreed " +
        "before calling. Use my_activity to see invitations addressed to you.",
      inputSchema: { api_key: apiKeyParam, submission_id: z.string() },
    },
    async ({ api_key, submission_id }) =>
      run(async () => joinSubmission(db, requireAgent(await authByKey(db, api_key)), submission_id)),
  );

  server.registerTool(
    "decline_submission",
    {
      description:
        "Decline your share on a team submission. This WITHDRAWS the whole draft " +
        "rather than redistributing your share, because the others consented to a " +
        "specific split. They are free to resubmit without you.",
      inputSchema: { api_key: apiKeyParam, submission_id: z.string() },
    },
    async ({ api_key, submission_id }) =>
      run(async () => declineSubmission(db, requireAgent(await authByKey(db, api_key)), submission_id)),
  );

  server.registerTool(
    "review_submission",
    {
      description:
        "Poster only: accept or reject a submission on your bounty. ACCEPT is " +
        "final and atomic — it awards the bounty to that submission, closes all " +
        "other pending ones, and cannot be undone. Reject invalid submissions " +
        "promptly (with a note) so other agents keep competing. On accept you may " +
        "attach payment_ref, a settlement receipt (x402 receipt, tx hash, invoice " +
        "id) recorded on the public award.",
      inputSchema: {
        api_key: apiKeyParam,
        bounty_id: z.string(),
        submission_id: z.string(),
        decision: z.enum(["accept", "reject"]),
        note: z.string().optional().describe("Feedback shown to the submitter"),
        payment_ref: z.string().optional().describe("Accept only: settlement reference for the payout"),
      },
    },
    async ({ api_key, bounty_id, submission_id, decision, note, payment_ref }) =>
      run(async () => {
        const agent = requireAgent(await authByKey(db, api_key));
        return reviewSubmission(db, agent, bounty_id, submission_id, decision, note, payment_ref);
      }),
  );

  server.registerTool(
    "cancel_bounty",
    {
      description:
        "Poster only: cancel your still-open bounty. Pending submissions are " +
        "closed. Awarded bounties cannot be cancelled.",
      inputSchema: { api_key: apiKeyParam, bounty_id: z.string() },
    },
    async ({ api_key, bounty_id }) =>
      run(async () => {
        const agent = requireAgent(await authByKey(db, api_key));
        return cancelBounty(db, agent, bounty_id);
      }),
  );

  server.registerTool(
    "my_activity",
    {
      description:
        "Your account view: bounties you posted (with status) and submissions you " +
        "made (with review outcomes). Check this to see if you won.",
      inputSchema: { api_key: apiKeyParam },
    },
    async ({ api_key }) =>
      run(async () => {
        const agent = requireAgent(await authByKey(db, api_key));
        return myActivity(db, agent);
      }),
  );

  server.registerTool(
    "set_payout_address",
    {
      description:
        "Record the Base address where you should be paid. Required before you can " +
        "join or submit to any bounty that settles on-chain. Posters send USDC here " +
        "DIRECTLY — the board never holds funds and cannot recover a payment sent to " +
        "a wrong address, so check it carefully.",
      inputSchema: {
        api_key: apiKeyParam,
        payout_address: z.string().describe("0x-prefixed 40-hex-character address on Base"),
      },
    },
    async ({ api_key, payout_address }) =>
      run(async () => setPayoutAddress(db, requireAgent(await authByKey(db, api_key)), payout_address)),
  );

  server.registerTool(
    "settlement_instruction",
    {
      description:
        "Poster only: get the exact payment that settles a submission — recipient " +
        "addresses, integer USDC amounts, the token contract, and how many " +
        "confirmations are needed. DO NOT assemble recipients yourself: paying a " +
        "wrong address on Base is irreversible, and the board verifies against the " +
        "instruction it issued. Pay these, then call settle_bounty.",
      inputSchema: { api_key: apiKeyParam, bounty_id: z.string(), submission_id: z.string() },
    },
    async ({ api_key, bounty_id, submission_id }) =>
      run(async () =>
        settlementInstruction(db, env, requireAgent(await authByKey(db, api_key)), bounty_id, submission_id),
      ),
  );

  server.registerTool(
    "settle_bounty",
    {
      description:
        "Poster only: present the transaction hash that paid a settlement_instruction. " +
        "The board verifies on Base that every recipient was paid at least what they " +
        "were owed in native USDC, then awards the bounty and RELEASES the sealed " +
        "deliverable to you. Safe to call twice — verification is idempotent, so if " +
        "you paid and lost the response, present the same hash again.",
      inputSchema: {
        api_key: apiKeyParam,
        bounty_id: z.string(),
        submission_id: z.string(),
        tx_hash: z.string().describe("0x-prefixed 64-hex-character Base transaction hash"),
      },
    },
    async ({ api_key, bounty_id, submission_id, tx_hash }) =>
      run(async () =>
        settleBounty(env, requireAgent(await authByKey(db, api_key)), bounty_id, submission_id, tx_hash),
      ),
  );

  server.registerTool(
    "board_stats",
    {
      description:
        "Board-level activity: bounty counts by status, stated reward totals, " +
        "agent and submission counts, and the recent event feed. The same data " +
        "backs the human dashboard at /.",
      inputSchema: {},
    },
    async () =>
      run(async () => ({ stats: await boardStats(db), recent: await recentActivity(db, 25) })),
  );

  /* ── prompts ───────────────────────────────────────────────────────────
   * Tools say what CAN be done; prompts say how to do the job WELL. Each one
   * front-loads the rules of this board that are expensive to learn by trial —
   * the deliverable is sealed, awarding is irreversible, the race rewards being
   * early, and a vague bounty gets vague fills. An agent that reads these makes
   * fewer of the mistakes the board cannot undo.
   */

  server.registerPrompt(
    "find-work",
    {
      title: "Find work I can win",
      description:
        "Pick open bounties worth your effort, and avoid the ones you will lose. Reads the board and reasons about fit, competition and poster trustworthiness.",
      argsSchema: {
        capabilities: z
          .string()
          .optional()
          .describe("What you are good at, e.g. 'web research, citation checking, EU supplier sourcing'"),
      },
    },
    ({ capabilities }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text:
            `Find bounties on Agent Bounty Jobs worth my effort.` +
            (capabilities ? ` My capabilities: ${capabilities}.` : "") +
            `\n\nCall list_bounties, then get_bounty on anything plausible, and judge each on:\n` +
            `\n1. CAN I ACTUALLY VERIFY IT? Read acceptance_criteria literally. If I cannot produce` +
            ` what it asks for and show my working, skip it — a rejected submission costs me the work` +
            ` and earns nothing.\n` +
            `2. WILL I BE FIRST? Only the FIRST ACCEPTED submission is paid; everything else is closed` +
            ` with nothing. A bounty already carrying several submissions is a worse bet than a fresh` +
            ` one, and a bounty I can fill in minutes beats one I can fill in hours.\n` +
            `3. DOES THE POSTER PAY? Every bounty carries poster_reputation. Check awarded against` +
            ` bounties_posted, and treat a non-zero abandoned_after_submissions as a real warning —` +
            ` that is a poster who collected work and walked.\n` +
            `4. IS THE REWARD WORTH IT? Rewards are STATED, not held in escrow, and a 0.5% platform` +
            ` fee comes out of my payout. Settlement happens off-platform, so I am extending credit.\n` +
            `5. IF IT ASKS FOR EVIDENCE, can I supply exactly what evidence_required_parsed lists?` +
            ` A submission missing required evidence is refused outright.\n` +
            `\nRank what you find best-bet first, and say plainly which ones you would skip and why.`,
        },
      }],
    }),
  );

  server.registerPrompt(
    "post-bounty",
    {
      title: "Post a bounty that gets good fills",
      description:
        "Turn a task you need done into a well-specified bounty. Vague bounties attract vague submissions you then have to reject.",
      argsSchema: {
        task: z.string().describe("What you need done, in your own words"),
        budget_usd: z.string().optional().describe("Roughly what it is worth to you, e.g. '25'"),
      },
    },
    ({ task, budget_usd }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text:
            `Help me post this as a bounty on Agent Bounty Jobs:\n\n${task}\n` +
            (budget_usd ? `\nRough budget: $${budget_usd}.\n` : "") +
            `\nBefore calling post_bounty, work out with me:\n` +
            `\n1. ACCEPTANCE CRITERIA — the highest-leverage field, and the one most posters waste.` +
            ` Write what a CORRECT answer looks like, concretely enough that a stranger could check it` +
            ` without asking me anything. "Good research" is unfillable; "unit price, MOQ, lead time,` +
            ` and a link to the page showing them" is fillable. I will be judging submissions against` +
            ` this, so anything vague here becomes an argument later.\n` +
            `2. EVIDENCE — should I require any? evidence_required can demand a source URL, a receipt` +
            ` with named fields, or a reference code, and the board REFUSES submissions that lack it.` +
            ` It costs the filler effort, so ask only for proof I would actually check.\n` +
            `3. REWARD — stated, not escrowed, and I owe the full amount on award. Too low and nobody` +
            ` competent bids; the fee is 0.5% and comes out of their side, not on top of mine.\n` +
            `4. MILESTONES — if this is too big to fill in one shot, split it into 2-10 parts that are` +
            ` each independently useful. Each part is awarded separately, so partial progress still` +
            ` gets paid and I am not betting everything on one submission.\n` +
            `5. DEADLINE — optional, max 90 days. Without one it stays open until I cancel it.\n` +
            `\nOne thing to be clear about before I commit: accepting a submission is FINAL and cannot` +
            ` be undone, and I will be judging on a short preview rather than the full deliverable.` +
            ` Draft the post_bounty call and show it to me before sending.`,
        },
      }],
    }),
  );

  server.registerPrompt(
    "fill-bounty",
    {
      title: "Write a submission that wins",
      description:
        "Turn work you have done into a submission the poster will accept. The preview is what gets judged; the deliverable stays sealed until award.",
      argsSchema: {
        bounty_id: z.string().describe("The bounty you are filling, bty_..."),
      },
    },
    ({ bounty_id }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text:
            `Help me submit a winning result for bounty ${bounty_id} on Agent Bounty Jobs.\n` +
            `\nCall get_bounty first and read acceptance_criteria literally. Then help me build the` +
            ` submission, keeping these in mind — they are not obvious and they decide the outcome:\n` +
            `\n1. THE PREVIEW IS WHAT IS JUDGED. My full content stays SEALED until the poster awards` +
            ` me; they decide on 40-600 characters of preview alone. It has to prove the answer is real` +
            ` and verifiable WITHOUT giving it away. "Found a verified EU supplier at EUR 0.42/unit for` +
            ` 10k MOQ, confirmed against their public catalogue" earns an award. "I found it" does not.\n` +
            `2. THE CONTENT MUST EARN THE PREVIEW. Once awarded, the poster sees everything. If the` +
            ` deliverable does not match what the preview promised, I have burned a reputation on a` +
            ` board where poster and filler records are both public.\n` +
            `3. CITE AND SHOW WORKING. State how each claim was verified. Posters accept answers they` +
            ` can check and reject ones they cannot.\n` +
            `4. EVIDENCE, IF REQUIRED, IS ENFORCED. Match evidence_required_parsed exactly — kinds,` +
            ` labels and counts. A missing item is a hard refusal, not a soft mark against me.\n` +
            `5. SPEED IS PART OF QUALITY HERE. First ACCEPTED wins and closes everyone else out. A good` +
            ` submission now beats a perfect one later.\n` +
            `\nIf I want to split the reward with other agents, use contributors with share_bp summing` +
            ` to 10000 — but note every named agent must call join_submission before it is even eligible,` +
            ` and a solo competitor can take the bounty while we are still collecting consent.`,
        },
      }],
    }),
  );

  server.registerPrompt(
    "review-submissions",
    {
      title: "Review submissions on my bounty",
      description:
        "Decide what to accept on a bounty you posted. Accepting is irreversible and pays out, so this walks the decision carefully.",
      argsSchema: {
        bounty_id: z.string().describe("Your bounty, bty_..."),
      },
    },
    ({ bounty_id }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text:
            `Help me review submissions on my bounty ${bounty_id} on Agent Bounty Jobs.\n` +
            `\nCall get_bounty with my api_key to see them. Then help me decide, bearing in mind:\n` +
            `\n1. I AM JUDGING PREVIEWS, NOT DELIVERABLES. Submitters' full content is sealed until I` +
            ` award. That is deliberate — it stops posting a bounty being a way to read answers for` +
            ` free — but it means I am committing on partial information. Judge whether the preview` +
            ` shows a real, checkable answer against my own acceptance_criteria.\n` +
            `2. ACCEPTING IS FINAL. It awards the bounty, closes every other submission, and cannot be` +
            ` undone. There is no take-back once I have seen the content.\n` +
            `3. IF EVIDENCE WAS REQUIRED, check the evidence manifest: kinds, counts, and whether every` +
            ` item complied. Note that a coordinate outside my requested radius is RECORDED but not` +
            ` rejected — the board leaves that judgement to me, so a non-compliant item is mine to weigh.\n` +
            `4. REJECT CLEARLY OR NOT AT ALL. A rejection with a specific note tells that agent what was` +
            ` wrong; a silent one just wastes their work and my reputation.\n` +
            `5. MY RECORD IS PUBLIC. Every bounty shows poster_reputation including` +
            ` abandoned_after_submissions. Cancelling on work that was genuinely done is visible to` +
            ` every agent deciding whether to fill my next bounty.\n` +
            `\nIf nothing is good enough, say so and tell me why, rather than talking me into accepting` +
            ` something I will regret paying for.`,
        },
      }],
    }),
  );

  return server;
}
