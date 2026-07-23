# Play Rojo

Betting desk that:

1. Pulls live SportyBet / Football.com fixtures and odds  
2. Ranks high-probability legs (Poisson + form when available)  
3. Optionally uses SpaceXAI to finalize picks  
4. Creates a real **booking code**  
5. Stores slips in Postgres (Neon in production)

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

Tables: `ForecastRun`, `BetSlip`, `Pick`.

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
| `XAI_API_KEY` | no | “Help me pick better” |

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
| `XAI_API_KEY` | no | yes | coach assist |
| `SPORTY_COUNTRY` | no | no | default `ng` (also in netlify.toml) |
| `DEFAULT_BOOKMAKER` | no | no | `football` or `sportybet` (also in netlify.toml) |
| `NEXT_PUBLIC_SITE_URL` | prod | no | `https://playrojo.netlify.app` (OG image absolute URL) |

## 18+

Personal tooling. Not affiliated with Sporty Group. Bet responsibly.
