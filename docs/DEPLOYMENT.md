# Deployment

## 1. Google Cloud OAuth client

Create a Web application OAuth 2.0 client in the institution's Google Cloud project. Add the exact GitHub Pages origin and any approved local development origin to authorized JavaScript origins. Record the public client ID; do not create or expose a client secret for this browser flow.

## 2. Apps Script and database

Run `pnpm install` and `pnpm --filter @erfa/apps-script build`. Create a standalone Apps Script project, add `apps-script/dist/Code.js`, and replace the manifest with `apps-script/dist/appsscript.json`. Alternatively, with clasp logged in and `apps-script/.clasp.json` linked to the project (see `.clasp.json.example`), `pnpm --filter @erfa/apps-script push` builds and uploads both files; then publish a new version of the existing Web App deployment with `clasp create-deployment -i <deploymentId> -d "<description>"` so the `/exec` URL stays the same. From the editor:

1. Run `setupDatabase()` and grant the requested Sheets, Drive, Mail, and external-request scopes.
2. Open the returned spreadsheet URL.
3. Set `GOOGLE_CLIENT_ID` and `FRONTEND_URL`; optionally set `ALLOWED_DOMAIN`.
4. Run `bootstrapAdmin('real.admin@institution.edu', 'Real Administrator')` once.

`setupDatabase()` can be rerun safely. It never clears rows; it stops on conflicting headers instead of guessing a migration.

Deploy as a Web App. Execute as the project owner so one institutional database, Drive hierarchy, and MailApp identity are used. Limit who has access to the intended Workspace audience when available. Copy the `/exec` URL. A new Apps Script version must be deployed after every backend code change.

## 3. Frontend and GitHub Pages

Set these GitHub repository variables:

- `VITE_API_URL`: Apps Script `/exec` URL
- `VITE_GOOGLE_CLIENT_ID`: the same OAuth web client ID
- `VITE_BASE_PATH`: `/<repository-name>/` for project Pages or `/` for a custom/root site

Enable Pages with **GitHub Actions** as the source. The included workflow installs, checks, builds, and publishes `frontend/dist`. The SPA uses hash routing so direct links survive GitHub Pages static hosting.

After the final Pages URL is known, set `FRONTEND_URL` in `SETTINGS` to that origin and repository path, without a trailing slash. Email links add `/#/rfa/<id>` automatically.

## 4. Organizational configuration

Sign in as the initial admin. Add real departments, then real users, then approval matrix rows. Do not edit generated stable IDs. Run all Workspace acceptance scenarios before inviting production users.

## 5. Production checklist

- Apps Script Web App audience restricted appropriately
- OAuth JavaScript origin exactly matches Pages
- no secrets or institutional data committed
- `EMAIL_ENABLED=TRUE` and a real notification test is `SENT`
- attachment root is institution-owned and private
- every active department has a complete valid approval route
- self-approval and return/resubmit scenarios pass
- print/PDF output reviewed with a real completed RFA
- administrators know how to inspect notification failures and workflow exceptions
