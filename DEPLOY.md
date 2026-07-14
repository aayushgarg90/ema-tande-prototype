# Running the prototype

The app is a plain Node/Express server (`server.js`) that serves the static
page and exposes two endpoints:

- `POST /api/chat` — Step 1: the booking chat. Every message calls Claude
  directly (no intent classification) to drive a directed conversation that
  collects the minimum trip details.
- `POST /api/search-flights` — Step 2: the Travel Agent. Fires once the chat
  has everything it needs. Calls Claude with Kiwi.com's public MCP server
  connected as a tool and returns the top 3 real flights. The hotel in the
  response is a clearly-labeled placeholder — Kiwi's MCP only covers flights,
  so hotel search isn't wired to a real source yet.
- `POST /api/generate-report` / `POST /api/extract-receipt` — Step 3: the
  Expense Agent assembles the report from the real booking and reads snapped
  receipt photos via Claude vision.
- `POST /api/check-inbox` — Step 3, optional: scans a real Gmail inbox (IMAP)
  for emails whose subject line matches the trip's destination city, reads
  the ones that look like real receipts, and returns them as suggestions for
  the traveler to accept or dismiss — nothing is auto-added.

Your Anthropic key lives only in `ANTHROPIC_API_KEY` on the server — it is
never sent to the browser. Same for the Gmail credentials below.

## Run it locally

```bash
npm install
cp .env.example .env      # then edit .env and add your ANTHROPIC_API_KEY
npm start                 # node server.js — serves http://localhost:3000
```

### Optional: inbox receipt scanning

The "check inbox for receipts" button needs IMAP access to a Gmail account:

1. Turn on 2-Step Verification on the Gmail account (Google requires this for
   app passwords): https://myaccount.google.com/security
2. Generate an app password: https://myaccount.google.com/apppasswords
3. Set `GMAIL_ADDRESS` (the full address) and `GMAIL_APP_PASSWORD` (the
   16-character app password, not the account's real password) in `.env`.

Without these two variables set, the button shows a clear "not connected"
message instead of failing silently — every other feature still works.

Open **http://localhost:3000**. No passphrase, no client-side key entry —
just chat.

## Deploying it

This is a persistent Node process (Express), not a set of serverless
functions, so it needs a host that runs `node server.js` continuously —
for example [Render](https://render.com), [Railway](https://railway.app), or
[Fly.io](https://fly.io). All three: point them at this repo, set the start
command to `npm start`, and add `ANTHROPIC_API_KEY` as an environment
variable in their dashboard (never commit it).

If you want a public link locked down before sharing it (so a stranger can't
run up your Anthropic bill), the simplest option is host-level access control
— e.g. Render's basic auth / IP allowlist — rather than building a passphrase
gate into the app. Ask if you want that added back in.

Never commit `.env`. It's already in `.gitignore`.
