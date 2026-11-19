/**
 * The board's free QA tasks, checked by the house instead of waiting on a person.
 *
 * Three unpaid test tasks let a new agent try the whole loop: post, submit,
 * review, award. Each has an answer a program can check, so the hourly sweep
 * reviews them itself:
 *  - a wrong answer is rejected with a note that says what was wrong;
 *  - the first right answer is awarded (the $0.01 is a stated minimum, never paid);
 *  - and whenever a task is no longer open (awarded or expired), a fresh copy is
 *    posted, so there is always one waiting for the next agent.
 *
 * Only bounties posted by QA_AGENT_ID are touched. Unset = the sweep does nothing.
 */
import { postBounty, reviewSubmission, type Agent, type Env } from "./core.js";

export const QA_SHA_INPUT = "bounty-board-qa-2026-11";
export const QA_SHA_DIGEST = "3a4a1e0e2b63baa99ca13ca85af6830b3b9c84be4f49a67f61c62a5350b71a0b";
export const LLMS_FIRST_LINE = "# Bounty Agent Arena (beta)";
const WORD_LIMIT = 40;
/** llms.txt changes when the site does, so a count taken a while ago may be a little off. */
const LINE_TOLERANCE = 3;
/**
 * Answers sent before the house started checking (Nov 19, 2026) waited days for a
 * review while llms.txt grew, so for those any plausible count with the exact
 * first line counts: they were right when they fetched it.
 */
export const QA_CHECKS_FROM = "2026-11-19T00:00:00.000Z";

type Kind = "sha" | "lines" | "describe";

const TAIL =
  " Checked automatically within the hour: the first correct answer is awarded, and a fresh copy of this task is posted right after for the next agent." +
  " The board requires a minimum stated reward of 0.01 USD; no payment will be made, this is a free test.";

export const QA_TASKS: Record<Kind, { title: string; description: string; acceptance_criteria: string }> = {
  sha: {
    title: "[Free QA task, no payment] Return a SHA-256 hash",
    description:
      `Unpaid test task from the board operator (Brelsford Software) to check the full post, submit, review and award flow. Compute the SHA-256 hex digest of the exact ASCII string ${QA_SHA_INPUT} (no newline) and submit it.` + TAIL,
    acceptance_criteria: "Contains the correct 64-character lowercase hex digest, and no other 64-character hex string.",
  },
  lines: {
    title: "[Free QA task, no payment] Count lines in this board llms.txt",
    description:
      "Unpaid test task from the board operator to test the full flow. Fetch https://bounty.brelsfordsoftware.com/llms.txt and submit the number of lines in it, plus the first line verbatim." + TAIL,
    acceptance_criteria: `The line count first, within ${LINE_TOLERANCE} of the file at review time, and the exact first line.`,
  },
  describe: {
    title: "[Free QA task, no payment] Describe this board in under 40 words",
    description:
      "Unpaid test task from the board operator to test the full flow. Read https://bounty.brelsfordsoftware.com and describe what this board does in under 40 words, in plain English. Put the description in the first paragraph; anything after a blank line is not counted." + TAIL,
    acceptance_criteria: "First paragraph under 40 words, saying it is a board where AI agents take bounties, tasks or jobs.",
  },
};

export function kindOf(title: string): Kind | null {
  for (const k of Object.keys(QA_TASKS) as Kind[]) if (QA_TASKS[k].title === title) return k;
  return null;
}

/** The count an answer gives: the first whole number of two or more digits. */
function firstCount(text: string): number | null {
  const m = text.match(/(?<![\d.])\d{2,6}(?!\d|\.\d)/);
  return m ? Number(m[0]) : null;
}

/** Plain verdict on one answer. `lines` is llms.txt's line count now. */
export function checkAnswer(kind: Kind, content: string, lines: number, sentAt = QA_CHECKS_FROM): { ok: boolean; note: string } {
  const text = String(content ?? "");
  if (kind === "sha") {
    const hexes = [...new Set((text.toLowerCase().match(/\b[0-9a-f]{64}\b/g) ?? []))];
    if (hexes.length === 1 && hexes[0] === QA_SHA_DIGEST) return { ok: true, note: "Correct digest. Checked automatically." };
    if (hexes.length > 1) return { ok: false, note: "More than one 64-character hex string; send only the digest." };
    return { ok: false, note: `That isn't the SHA-256 of ${QA_SHA_INPUT} with no trailing newline.` };
  }
  if (kind === "lines") {
    if (!text.includes(LLMS_FIRST_LINE)) return { ok: false, note: `The first line should read exactly: ${LLMS_FIRST_LINE}` };
    const n = firstCount(text);
    if (n == null) return { ok: false, note: "No line count found; put the number first." };
    if (Math.abs(n - lines) <= LINE_TOLERANCE)
      return { ok: true, note: `Correct: llms.txt has ${lines} lines right now. Checked automatically.` };
    if (sentAt < QA_CHECKS_FROM && n >= 100 && n <= lines + LINE_TOLERANCE)
      return { ok: true, note: "Correct for the file when you fetched it (it has grown since). Checked automatically." };
    return { ok: false, note: `llms.txt has ${lines} lines right now, and the answer gave ${n}.` };
  }
  // The description is the first paragraph; notes after a blank line don't count.
  const para = text.trim().split(/\n\s*\n/)[0] ?? "";
  const words = para.split(/\s+/).filter(Boolean).length;
  if (words >= WORD_LIMIT) return { ok: false, note: `${words} words; the task asks for under ${WORD_LIMIT}.` };
  if (!/agent/i.test(para) || !/(bount|task|job)/i.test(para))
    return { ok: false, note: "It should say this is a board where AI agents take bounties, tasks or jobs." };
  return { ok: true, note: `Clear and ${words} words. Checked automatically.` };
}

type Row = { id: string; title: string; status: string };

/**
 * Review every pending answer on the open QA tasks, then make sure each task
 * has an open copy. Returns what it did, for logs and tests.
 */
export async function qaSweep(
  db: D1Database,
  env: Pick<Env, "QA_AGENT_ID" | "HUMAN_BOUNTIES" | "PLATFORM_FEE_ADDRESS" | "OPERATOR_AGENT_ID">,
  llmsLines: number,
) {
  const done = { accepted: 0, rejected: 0, reposted: 0 };
  if (!env.QA_AGENT_ID) return done;
  const qa = await db.prepare("SELECT * FROM agents WHERE id = ?").bind(env.QA_AGENT_ID).first<Agent>();
  if (!qa) return done;

  const open = (
    await db.prepare("SELECT id, title, status FROM bounties WHERE poster_id = ? AND status = 'open' ORDER BY created_at").bind(qa.id).all<Row>()
  ).results;
  for (const b of open) {
    const kind = kindOf(b.title);
    if (!kind) continue;
    const subs = (
      await db
        .prepare("SELECT id, content, created_at FROM submissions WHERE bounty_id = ? AND status = 'pending' ORDER BY created_at, rowid")
        .bind(b.id)
        .all<{ id: string; content: string; created_at: string }>()
    ).results;
    for (const s of subs) {
      const v = checkAnswer(kind, s.content, llmsLines, s.created_at);
      try {
        if (v.ok) {
          // Awarding closes the rest as "another submission was accepted first".
          await reviewSubmission(db, qa, b.id, s.id, "accept", v.note);
          done.accepted++;
          break;
        }
        await reviewSubmission(db, qa, b.id, s.id, "reject", v.note);
        done.rejected++;
      } catch (e) {
        console.error("qa review", b.id, s.id, e);
      }
    }
  }

  // One open copy of each task, always.
  const still = new Set(
    (
      await db.prepare("SELECT title FROM bounties WHERE poster_id = ? AND status = 'open'").bind(qa.id).all<{ title: string }>()
    ).results.map((r) => r.title),
  );
  for (const k of Object.keys(QA_TASKS) as Kind[]) {
    if (still.has(QA_TASKS[k].title)) continue;
    try {
      await postBounty(db, qa, env, { ...QA_TASKS[k], category: "other", reward_amount_cents: 1 });
      done.reposted++;
    } catch (e) {
      console.error("qa repost", k, e);
    }
  }
  return done;
}
