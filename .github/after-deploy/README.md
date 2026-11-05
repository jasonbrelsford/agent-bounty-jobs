# After-deploy check

Every time this repo deploys to production, `.github/workflows/after-deploy.yml` loads the live site's
key pages and makes sure each one answers and shows what it should. If something is broken, it puts the
site back to the last deploy that passed, checks again, and opens an issue that names the change.

- **What it checks:** `checks.json`. Every check is a plain GET request: no sign-ups, no forms, no emails,
  no paid API calls. Its User-Agent says `bot` and `monitor`, so the sites' own visit counters file it
  under bots. Keep the expected text loose (a brand name, not a sentence), so a copy change never looks
  like an outage.
- **When it runs:** when Cloudflare's build or this repo's deploy workflow finishes on `main`. It waits
  until every deploy of that commit has finished, and only judges the newest one.
- **Flaky pages:** a check only counts as failed after 3 tries, 30 seconds apart.

## What happens when a check fails

1. The commit gets a red `after-deploy` status. (Passing deploys get a green one: that is how it knows
   the last good deploy.)
2. It makes one new commit on `main` whose site files are exactly those of the last good deploy, so
   main and the live site agree. Where this repo deploys from GitHub Actions, it then starts that
   deploy workflow; where Cloudflare builds it, Cloudflare picks up the commit as usual.
3. It waits for that deploy, checks again, and opens an issue labelled `deploy-rollback` with what
   broke, which change caused it (with its pull request), what was undone, and the re-check result.

## What stops a rollback

- **Never more than one step.** A rollback commit is never rolled back. If the site is still broken
  after one, it comments on the issue and stops: a person takes it from there.
- **Database changes.** If the change includes a migration or a Cloudflare config change (the
  `hold_paths` in `checks.json`), it does not roll back on its own, because old code over a new database
  can make things worse. It opens an issue instead.
- **Not a code problem.** If the code already matches the last good deploy (a Cloudflare or database
  outage), there is nothing to roll back; it opens an issue.
- **A newer deploy is coming.** If newer changes landed on main, it leaves the verdict to their check.

## Running it by hand

Actions tab > after-deploy > Run workflow:
- `check`: look at the live site now, change nothing.
- `plan`: pretend the check failed and print what a rollback would do, change nothing.
- `full`: check, and roll back if broken.

To ship a rolled-back change again, fix it in a new pull request (`git revert <rollback commit>`
brings the change back as it was). To pause all of this, disable the after-deploy workflow.
