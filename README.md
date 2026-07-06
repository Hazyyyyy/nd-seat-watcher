# nd-seat-watcher

Zero-cost watcher for Notre Dame PATH seat availability. It reads the
**public** class search at https://classsearch.nd.edu/, checks a list of
CRNs, and fails a GitHub Action (red X) if any of them looks open — that's
your alert. Check GitHub's notification settings if you want an email/push
alert on failed runs.

**What this does NOT do:** it does not log into NOVO or PATH, does not store
any credentials, and does not register you for anything. It only reads a
public search page and reports what it sees.

## Setting your CRNs

The watcher reads two environment variables:

- `ND_TERM` — the term to search, e.g. `Fall Semester 2026` (this is the
  default if unset).
- `ND_CRNS` — a comma-separated list of CRNs to check, e.g. `12345,67890`.

For the GitHub Action, set these as **repository variables** (not secrets —
CRNs aren't sensitive):

1. Go to your repo's **Settings → Secrets and variables → Actions → Variables**.
2. Add a variable named `ND_CRNS` with your comma-separated CRN list.
3. Optionally add `ND_TERM` if you need a term other than the default.

## Running locally

```bash
npm install
npx playwright install chromium
ND_CRNS="12345,67890" node watch-path.js
```

On Windows PowerShell:

```powershell
npm install
npx playwright install chromium
$env:ND_CRNS="12345,67890"; node watch-path.js
```

Exit codes:

- `0` — checked everything, no seats look open.
- `1` — at least one CRN looks open (also prints
  `SEAT MAY BE OPEN FOR CRN [CRN]. GO TO NOVO NOW.`).
- `2` — the script itself failed (site unreachable, page layout changed,
  etc.) — check the printed error.

## Testing the GitHub Action manually

1. Push this repo to GitHub and set the `ND_CRNS` repository variable (see
   above).
2. Go to the **Actions** tab → **Watch PATH Seats** workflow → **Run workflow**
   (this uses the `workflow_dispatch` trigger, no need to wait for the cron).
3. Check the run's logs for the per-CRN snippet and status. If a run fails
   with exit code 2, download the `debug-artifacts` artifact from the run
   (screenshot + HTML) to see what the page looked like — the site's layout
   can change, and the keyword/term selectors may need adjusting.

Once set up, the workflow runs automatically every 10 minutes via
`schedule: cron: '3/10 * * * *'`.

## How detection works

`classsearch.nd.edu` is a client-rendered page, so this script uses
heuristics rather than hard-coded element IDs: it finds the CRN on the
rendered page, reads the surrounding text, and looks for words like "Open"
vs "Full"/"Closed", or a seat-count pattern. If it can't confidently tell,
it reports `unknown` and does **not** treat that as open, and writes debug
artifacts (`debug/`) so you can see why. If you notice misclassifications,
adjust `classifyStatus()` in `watch-path.js`.
