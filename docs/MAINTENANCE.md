# Long-term Maintenance

eRFA is built to keep working for many years with little upkeep. This page lists what it depends on, what to check each year, and how to make the common changes safely.

## What eRFA depends on

| Piece | What it does | Can it change under us? |
|---|---|---|
| GitHub Pages | Hosts the website (`frontend/`) | Rarely. The site is plain static files. |
| Google Apps Script (V8 runtime) | Runs the backend (`apps-script/`) | Google announces runtime changes well in advance. |
| Google Sheets and Drive | Store records and attachments | Stable. A full backup is one "Make a copy" of the database spreadsheet. |
| Google Identity Services | "Sign in with Google" button | The only script loaded from Google at runtime. If Google replaces it, update `frontend/src/googleSignIn.tsx`, the one file that touches it. |
| MailApp | Sends notification emails | Daily limit: about 1,500 recipients on Google Workspace. |

Everything else (React, router, icons, the Inter font) ships inside the website build, so the site does not depend on any other outside service.

## Built-in resilience

- **Pinned versions.** Every package in `package.json` has an exact version and `pnpm-lock.yaml` is committed, so a rebuild years from now produces the same app. CI installs with `--frozen-lockfile`.
- **Expired sign-ins.** Google sign-ins last about an hour. When one expires, eRFA shows a "Please sign in again" box over the current page instead of failing, so a half-filled RFA is not lost (`SessionExpiredDialog` in `frontend/src/components.tsx`).
- **New deploys.** If someone has eRFA open while a new version is published, the next page they open reloads once to pick up the new files instead of showing a blank page (`withReload` in `frontend/src/App.tsx`).
- **Unexpected errors.** A friendly "Reload eRFA" message replaces a blank page (`ErrorBoundary`).
- **Speed.** Pages load only when first opened, the last-loaded lists show instantly while a fresh copy loads, and the backend caches sign-in checks and master data.

## Yearly checklist

1. Run `pnpm install --frozen-lockfile` and `pnpm check` (typecheck, lint, tests, build). All should pass.
2. Sign in on the live site with an admin and an approver account; open the dashboard, My RFAs, For My Action and one RFA.
3. In the database spreadsheet, check the `NOTIFICATIONS` sheet for `FAILED` emails.
4. Check sheet size: Google Sheets allows 10 million cells per spreadsheet. At about 750 RFAs a year this is decades away; if it ever gets close, archive closed RFAs from older years into a copy.
5. Make a backup copy of the database spreadsheet (File → Make a copy).
6. Confirm the Google Cloud OAuth consent screen is still **In production** and **External** (needed for approvers from other domains).

## Updating packages (every 1–2 years, optional)

Updates are not required for the app to keep working. When you do update:

1. `pnpm up --latest -r` on a separate branch.
2. Pin the new versions exactly (no `^`), then run `pnpm check`.
3. Open the built site and click through the main pages before merging.

## Changing the look

All colours are CSS variables in `frontend/src/styles.css`. The brand palette (PaperPulse blues) lives in the `:root` blocks near the end of the file (`--navy`, `--blue`, `--pp-*`, `--hero-blend`). Change those values rather than individual rules.

## Deploying

- **Website:** push to `main`; GitHub Actions builds and publishes it.
- **Backend:** see [DEPLOYMENT.md](DEPLOYMENT.md). Always update the existing Web App deployment (`clasp deploy -i <deploymentId>`) so the `/exec` URL never changes.
- **Rollback:** in Apps Script, Deploy → Manage deployments → edit → pick the previous version. For the website, revert the commit and push.
