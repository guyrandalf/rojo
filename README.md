# Play Rojo

Betting desk that:

1. Pulls live SportyBet / Football.com fixtures and odds  
2. Analyses each match one request at a time (Poisson + form + H2H), so no
   single serverless call has to survive the whole board  
3. Ranks legs by analysis conviction and creates a real **booking code**  
4. Stores runs, candidates, and slips in Postgres (Neon in production)

The generate flow is chunked: `POST /api/forecast/start` scans the board and
queues matches, the browser then calls `POST /api/forecast/step` once per
match (2 in flight), and `POST /api/forecast/finish` ranks everything and
books the code. Every request stays comfortably inside Netlify's 10s
synchronous-function limit, and a failed match retries alone instead of
restarting the run.

## Stack

- Next.js 16 + React 19 + Tailwind CSS v4  
- Prisma 7 + PostgreSQL (Neon recommended)  
- Netlify (`@netlify/plugin-nextjs`)

## Local setup

```bash
cp .env.example .env
# put your Neon (or local) DATABASE_URL in .env
npm install
npx prisma db push
npm run dev
```

## Production database (Neon)

1. Create a Neon project and copy the **pooled** connection string.  
2. Ensure it ends with `?sslmode=require`.  
3. Set `DATABASE_URL` in:
   - local `.env` for `prisma db push` / `dev`
   - Netlify → Environment variables for deploys  
4. Push schema once from your machine (or CI):

```bash
npx prisma db push
```

Tables: `ForecastRun`, `Candidate`, `BetSlip`, `Pick`, `FormCache`.

## Netlify

Suggested site name: e.g. `playrojo` → `playrojo.netlify.app`

`netlify.toml` already sets **public** defaults:

- `SPORTY_COUNTRY=ng`
- `DEFAULT_BOOKMAKER=football`
- `NODE_VERSION=22`

### Secrets (Netlify UI only)

**Site configuration → Environment variables** → add and mark as secret:

| Name | Required | Notes |
|------|----------|--------|
| `DATABASE_URL` | yes | Neon pooled URL + `sslmode=require` |

Do **not** add `DEFAULT_BOOKMAKER` or `SPORTY_COUNTRY` as Netlify “secret” env vars.  
They are not secrets. If Netlify secret-scanning warns  
`Secret env var "DEFAULT_BOOKMAKER"'s value detected`, delete that secret  
from the UI (the value already comes from `netlify.toml`).

Build command is `npm run build` (`prisma generate && next build`).

## Env vars (local / general)

| Name | Required | Secret? | Notes |
|------|----------|---------|--------|
| `DATABASE_URL` | yes | yes | Neon pooled URL + `sslmode=require` |
| `DATABASE_SSL` | no | no | set `true` if URL has no sslmode |
| `SPORTY_COUNTRY` | no | no | default `ng` (also in netlify.toml) |
| `DEFAULT_BOOKMAKER` | no | no | `football` or `sportybet` (also in netlify.toml) |
| `NEXT_PUBLIC_SITE_URL` | prod | no | `https://playrojo.netlify.app` (OG image absolute URL) |

## 18+

Personal tooling. Not affiliated with Sporty Group. Bet responsibly.
