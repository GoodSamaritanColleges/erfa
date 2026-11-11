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
4. Confirm the June archive ran (admins receive an email; the maintenance panel shows the last archive date).
5. Check **Administration → Logs → Automatic maintenance** shows **On** with a recent backup.
6. Confirm the Google Cloud OAuth consent screen is still **In production** and **External** (needed for approvers from other domains).

## Automatic maintenance (backups and yearly archive)

Switch it on once: in the Apps Script editor run **`installAutomaticMaintenance`** and allow the permission Google asks for (scheduled jobs). It makes a first backup straight away. From then on, with nothing to click:

| When | What |
|---|---|
| 1st of every month, 2 AM (Manila) | Full copy of the database into **eRFA Backups/<year>** next to the database in Drive. Backups are never deleted. |
| June 15, 3 AM (15th of the school-year start month) | Yearly archive of the school year that ended (always backs up first). |

- Admins get an email after each run and an alert if one fails.
- **Administration → Logs → Automatic maintenance** shows On/Off, the last and next backup, the next archive, and links to recent backups. It warns if no backup ran for 35 days.
- **`backupNow`** in the editor makes an extra copy any time (before an import or big change). The archive and the post-pilot reset also save a copy to the same folder first.
- The app shows the current school year and the previous **2** (setting `VISIBLE_PAST_SCHOOL_YEARS`). Older school years disappear from the app but stay in their archive spreadsheets and in the monthly backups.
- The schedules run as the script owner. If that account is removed, they stop: keep a second owner on the Apps Script project.

## End of each school year: archive

The school year runs June to May by default (setting `SCHOOL_YEAR_START_MONTH`, 6 = June). This runs automatically on June 15 once automatic maintenance is on. To run it by hand instead, shortly after a school year ends:

1. In the Apps Script editor, run **`previewArchiveNow`**. It lists how many finished RFAs from past school years would be archived and changes nothing.
2. Run **`archivePastSchoolYearsNow`**. It:
   - makes a full backup copy of the database spreadsheet first;
   - moves finished RFAs (Approved, Closed, Disapproved, Cancelled) filed in past school years, with their approval rows, attachment records, history and email logs, into one spreadsheet per school year named "eRFA Archive SY 2025–2026" (next to the database in Drive);
   - checks each archive was written before removing those rows from the main database;
   - keeps unfinished RFAs (draft, pending, returned, implementation), every budget ledger entry, accounts and settings.
3. Users pick the year from the **School year** filter on My RFAs and All RFAs. Archived RFAs open read-only with their full history and attachments, with the same access rules. Expense reports for a fiscal year include its archived RFAs automatically.

It is safe to run again: RFAs finished late are added to the right year's archive. Attachment files are never moved; they already live in per-year Drive folders. Do not edit or delete archive spreadsheets by hand; their IDs are listed in the `ARCHIVES` sheet.

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
