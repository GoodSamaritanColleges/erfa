# Accounts and Ownership Plan

**Goal:** eRFA belongs to the school, not to one person, and keeps working even if any single email account is deleted.

**Status (2026-11-12):** Google side done. Shared drives are turned off at GSC, so instead of a shared drive the files were handed to erfa@ with `transferOwnershipNow` (run once by the previous owner; `previewOwnershipTransferNow` shows what it would move). erfa@ now owns the database, attachments, backups, archives and the Apps Script project; is Owner of the Google Cloud project; owns the three schedules (runMonthlyBackup, runYearlyArchive, runDailyFollowUps); and deployed the live web app (version 42, same URL). The previous owner's schedules were deleted. `clasp` is signed in as erfa@. **GitHub (2026-11-12):** the repository moved to the **GoodSamaritanColleges** GitHub account (signed up with the school email); build settings and Pages carried over. **Address (2026-11-13):** the site is served at **https://erfa.gsc.edu.ph/** through a CNAME record `erfa → goodsamaritancolleges.github.io` (DNS only) in the gsc.edu.ph Cloudflare account, which is run by the domain manager, plus the custom domain in GitHub → Settings → Pages; the old github.io link redirects there. gsc.edu.ph must keep being renewed yearly. **Still to do:** a backup owner (Google: editor on the files + Owner in Cloud IAM; GitHub: a personal account has one owner, so add a collaborator, or turn it into an organization for a second owner).

**Important for developers:** a `clasp deploy` runs the web app as whoever is signed in to clasp. Deploy only while signed in as erfa@, or the web app switches back to running as a personal account.

Without a shared drive, the files belong to the erfa@ account. Before that account is ever deleted, the Workspace admin must use **Transfer data** to another account. If the school later turns on shared drives, move the files into one.

## The accounts

| Account | Role |
|---|---|
| **erfa@goodsam.edu.ph** (new, Google Workspace) | Main owner of everything: Google data, Apps Script, Google Cloud sign-in, and the GitHub account/organization. Sends eRFA emails and runs the monthly backup and yearly archive. |
| **Backup owner** (a second school account, e.g. IT office or a named administrator) | Second owner/manager on everything below. Can take over in minutes if erfa@ is ever removed. |
| Personal account (current owner) | Stays as editor for a few weeks after the move, then is removed. |

Keep the passwords and GitHub recovery codes of erfa@ with the school (IT office or a shared password manager), never on one person's phone only.

## The rule: every piece has two owners

| Piece | Where it should live | Two owners how |
|---|---|---|
| Database spreadsheet, attachments folder, **eRFA Backups**, archive spreadsheets | A **Shared drive** named "eRFA" (files belong to the school, not to a person) | erfa@ and the backup owner are both **Managers** of the shared drive |
| Apps Script project | Inside the same "eRFA" shared drive | Both Managers can edit and redeploy |
| Google Cloud project (Google sign-in) | Same project, Client ID unchanged | erfa@ and the backup owner both **Owner** in IAM |
| GitHub website | A **GitHub organization** (e.g. `gsc-erfa`) with the `erfa` repository | erfa@'s GitHub account and the backup owner's GitHub account are both **Owners** of the organization |
| Google Workspace safety net | Admin console | When any account is deleted, the Workspace admin uses **Transfer data** to another account first |

Why a shared drive: files in someone's *My Drive* disappear with that person's account. Files in a shared drive belong to the school and survive any single account being deleted.

## What still depends on one account (and how to recover fast)

Two things in Apps Script always run "as" a person: the **web app** ("Execute as: Me") and the **schedules** (monthly backup, yearly archive). They run as erfa@. If erfa@ is ever removed:

1. The backup owner opens the Apps Script project (in the shared drive).
2. Runs **installAutomaticMaintenance** and clicks Allow (recreates the three schedules under their account).
3. **Deploy → Manage deployments → Edit → New version** (the web app now runs as them; **same URL**, nothing changes for users).

About 10 minutes. No data is lost because the data lives in the shared drive.

## Move checklist (in this order)

**Google**
1. Workspace admin creates **erfa@goodsam.edu.ph** (and confirms who the backup owner is).
2. Create a shared drive **"eRFA"**; add erfa@ and the backup owner as **Manager**; keep the current owner as Manager for now.
3. Move into it: the database spreadsheet, the attachments folder, **eRFA Backups**, the archive spreadsheets, and the Apps Script project. (File and folder IDs stay the same, so eRFA settings do not change.)
4. Google Cloud: add erfa@ and the backup owner as **Owner** of the eRFA project.
5. Signed in as **erfa@**: open the Apps Script project, run **installAutomaticMaintenance**, Allow; then **Deploy → Manage deployments → Edit → New version** so the web app runs as erfa@ (same URL).
6. Signed in as the **current owner**: Apps Script → Triggers → delete your three old schedules (runMonthlyBackup, runYearlyArchive, runDailyFollowUps), or backups run twice.
7. Developer re-links the deploy tool: `clasp login` as erfa@.

**GitHub**
8. Create the GitHub account with erfa@ (two-factor on; recovery codes stored with the school).
9. Create the organization (e.g. `gsc-erfa`); add the backup owner's GitHub account as a second **Owner**.
10. Transfer the `erfa` repository into the organization (or push it there). The build already follows the repository name automatically.
11. In the repository: Settings → Pages → **GitHub Actions**; Settings → Variables → add `VITE_API_URL` and `VITE_GOOGLE_CLIENT_ID` (same values as now).
12. Google Cloud → OAuth client → add `https://gsc-erfa.github.io` to **Authorized JavaScript origins**; Branding → add the domain and update the homepage and privacy policy links.
13. Test signing in on the new site.
14. eRFA Settings: set `FRONTEND_URL` to the new address (email links).
15. Announce the new link; then retire the old site and remove the personal account (keep it as editor for a few weeks first).

**Check after the move:** sign in on the new site; submit and approve a test RFA (email arrives from erfa@); Administration → Logs → Automatic maintenance shows **On**; the Triggers page shows exactly three schedules, under erfa@.
