# Our budget

Shared monthly budget for two. Static front end in `public/`, one Netlify Function (`netlify/functions/api.mts`)
storing each record as its own Netlify Blob, gated by a shared passphrase chosen on first open.

- `npm install` then `npm test` runs the API tests against an in-memory store.
- `node --experimental-strip-types test/dev-server.mts` previews the app locally on :8787 (in-memory data).
- Deploy: `netlify deploy --prod` (publish dir and functions are set in `netlify.toml`).
