# Rojo

Football multi builder that:

1. Pulls live upcoming fixtures/odds from SportyBet
2. Fits a **Poisson goals model** from de-vigged 1X2 + Over/Under lines
3. Enriches shortlisted matches with **recent form / H2H** (TheSportsDB, best-effort)
4. Builds a **research shortlist** ranked by model edge
5. With `XAI_API_KEY`, **Grok chooses the final legs and writes full reasons** before any booking code
6. Without a key, falls back to stats ranking with plain-English stats reasons
7. Creates a real **booking code** on SportyBet or Football.com
8. Stores slip history in local Postgres

SportyBet and Football.com share Sporty Group booking-code infrastructure. Codes work across both brands.

## Stack

- Next.js 16 (App Router) + React 19 + Tailwind CSS v4
- Prisma 7 + PostgreSQL (`postgresql://postgres@localhost:5432/rojo`)
- Vercel AI SDK + `@ai-sdk/xai` (optional)

## Setup

```bash
cd Software/Snowflakes/rojo
cp .env.example .env   # already set for local Postgres
npm install
npx prisma generate
npx prisma db push
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Optional: set `XAI_API_KEY` in `.env` for richer pick explanations.

## API

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/fixtures` | Live upcoming events + markets |
| `POST` | `/api/forecast` | Score, pick legs, create code, persist |
| `GET` | `/api/slips` | Recent slips |
| `GET/PATCH` | `/api/slips/[id]` | Detail / regenerate code / status |
| `POST` | `/api/booking-codes/load` | Load an existing share code |

### Forecast body example

```json
{
  "legCount": 5,
  "minOdds": 1.3,
  "maxOdds": 2.2,
  "bookmaker": "sportybet",
  "createCode": true,
  "useAi": true
}
```

## Notes

- Booking codes save a slip. They do **not** place a bet.
- Endpoints are the same public website APIs the SportyBet UI uses. They can change or rate-limit.
- Model output is highest-confidence ranking, not a guarantee. Multi-leg risk compounds.
- 18+. Bet responsibly.
