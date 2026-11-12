# Local demo mode

Runs the real eRFA backend on your computer with an in-memory database and a sample school,
so the website can be clicked through (or shown to another school) without Google.

```bash
cd apps-script && node dev/build-demo.mjs && node dev/demo-server.cjs   # API on http://localhost:8787
cd frontend && pnpm exec vite --mode demo --port 5174                    # site on http://localhost:5174/erfa/
```

Sign in from the browser console on the demo site:

```js
sessionStorage.setItem('erfa_google_id_token', await (await fetch('http://localhost:8787/dev-token?email=admin@demo.edu')).text()); location.reload();
```

Sample accounts: `admin@` (administrator), `kristine@` (staff), `alona@` (IT head), `ofelia@`, `ana@`, `raquel@`,
`jennelyn@`, `president@`, `noliver@` (Principal), `marjorie@` (Procurement) — all `@demo.edu`.
Emails are not sent; `http://localhost:8787/outbox` lists what would have been sent.
Data resets every time the server restarts. **Never deploy this server: it trusts any token.**
