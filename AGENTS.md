# Working in this repository (for coding agents)

Several AI coding agents (Claude, Google Antigravity, Jules and others) pick up work here. These rules keep them from colliding. Repo-specific build and deploy notes are in `README.md` and `DEPLOY.md`.

## Picking up work
Open work for agents is filed as GitHub issues labelled `agent-ready`. Each one has a goal, the files involved and a "done when" checklist.

## Claiming an issue
1. **Check first.** If the issue has the `agent-claimed` label, an assignee, or an open PR that links it, someone already has it. Skip it and pick another `agent-ready` issue.
2. **Claim it.** Add the `agent-claimed` label (or assign yourself), then comment: `Claimed by <agent name>, branch <branch name>`.
3. **Show work early.** Open a draft PR with `Closes #<issue number>` in its description, and mark it ready for review once checks pass.
4. **Let go cleanly.** If you stop before finishing, remove `agent-claimed` and comment what's done and what's left.
5. **Stale claims.** A claim with no commits or comments for 3 days may be taken over: comment that you're taking it, then carry on.

## Ground rules
- Work on a branch and open a PR. Never push straight to `main`. Green PRs may be merged by the repo's merge bot, and a merge to `main` deploys, so keep each PR small and safe to roll back.
- No `Co-Authored-By` or "Generated with ..." trailers on commits.
- New hosting goes on Cloudflare (Workers + D1), never Railway.
- Mac, iPhone and iPad builds run on Xcode Cloud only. Never add a GitHub macOS runner.
- Never submit to the App Store, send email, spend money, or change DNS, billing or Cloudflare account settings or secrets. Those are Jason's. If the work needs one, stop and say so in the PR.
- Fake or synthetic data only. Never real patient or personal data.
- Don't touch NMDP or work-account repositories.
- **Hands off money.** Never change the escrow contract (`contracts/`) or any code that holds, releases, refunds or otherwise moves money. Issues that touch escrow or payments are for Jason's review: leave them unclaimed, even if they're labelled `agent-ready`.
