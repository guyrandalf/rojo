import { NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { MarketKind } from "@/generated/prisma/client"
import { createShareCode } from "@/lib/sporty/client"
import type { Bookmaker } from "@/lib/sporty/types"

export const dynamic = "force-dynamic"

const legSchema = z.object({
  eventId: z.string().min(3),
  marketId: z.string().min(1),
  outcomeId: z.string().min(1),
  specifier: z.string().nullable().optional(),
  homeTeam: z.string().min(1),
  awayTeam: z.string().min(1),
  tournament: z.string().nullable().optional(),
  kickoffAt: z.string().nullable().optional(),
  marketDesc: z.string().min(1),
  outcomeDesc: z.string().min(1),
  odds: z.number().positive(),
  impliedProb: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  edge: z.number().optional(),
  reasoning: z.string().nullable().optional(),
})

const bodySchema = z.object({
  sourceSlipId: z.string().min(1),
  bookmaker: z.enum(["sportybet", "football"]).optional(),
  country: z.string().min(2).max(4).optional(),
  legs: z.array(legSchema).min(1).max(40),
})

function marketKind(marketId: string, desc: string): MarketKind {
  const d = desc.toLowerCase()
  if (marketId === "1" || d.includes("1x2")) return MarketKind.MATCH_RESULT
  if (marketId === "18" || d.includes("over/under") || d.includes("total")) {
    return MarketKind.OVER_UNDER
  }
  if (marketId === "29" || d.includes("both teams") || d.includes("btts") || d.includes("gg")) {
    return MarketKind.BTTS
  }
  if (d.includes("double chance")) return MarketKind.DOUBLE_CHANCE
  return MarketKind.OTHER
}

export async function POST(request: Request) {
  try {
    const json = await request.json()
    const parsed = bodySchema.safeParse(json)
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const source = await db.betSlip.findUnique({
      where: { id: parsed.data.sourceSlipId },
      include: { picks: true },
    })
    if (!source) {
      return NextResponse.json(
        { ok: false, error: "Source slip not found" },
        { status: 404 }
      )
    }

    // One pick per event
    const seen = new Set<string>()
    for (const leg of parsed.data.legs) {
      if (seen.has(leg.eventId)) {
        return NextResponse.json(
          { ok: false, error: "Only one pick per match allowed" },
          { status: 400 }
        )
      }
      // Snapshot-only outcome ids cannot be booked
      if (leg.outcomeId.startsWith("snap-")) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "Live market ids missing for a selection. Refresh the slip board and try again.",
          },
          { status: 400 }
        )
      }
      seen.add(leg.eventId)
    }

    const country = parsed.data.country ?? source.country
    const bookmaker = (parsed.data.bookmaker ??
      source.bookmaker) as Bookmaker

    const created = await createShareCode(
      parsed.data.legs.map((l) => ({
        eventId: l.eventId,
        marketId: l.marketId,
        outcomeId: l.outcomeId,
        specifier: l.specifier ?? null,
      })),
      { country, bookmaker }
    )

    const totalOdds = parsed.data.legs.reduce((acc, l) => acc * l.odds, 1)
    const combinedConf = parsed.data.legs.reduce(
      (acc, l) => acc * (l.confidence ?? l.impliedProb ?? 1 / l.odds),
      1
    )

    const parentCode = source.shareCode ?? source.id.slice(0, 8)
    const changed = parsed.data.legs.filter((leg) => {
      const orig = source.picks.find((p) => p.eventId === leg.eventId)
      if (!orig) return true
      return (
        orig.marketId !== leg.marketId ||
        orig.outcomeId !== leg.outcomeId ||
        orig.specifier !== (leg.specifier ?? null)
      )
    }).length

    const slip = await db.betSlip.create({
      data: {
        status: "CODED",
        label: `Remix · ${parentCode}`,
        totalOdds,
        combinedConf,
        shareCode: created.shareCode,
        shareUrl: created.shareURL,
        bookmaker,
        country,
        forecastRunId: source.forecastRunId,
        notes: `Remixed from ${parentCode} (${changed} leg${changed === 1 ? "" : "s"} changed). Live odds at cut time.`,
        picks: {
          create: parsed.data.legs.map((l) => ({
            eventId: l.eventId,
            homeTeam: l.homeTeam,
            awayTeam: l.awayTeam,
            tournament: l.tournament ?? null,
            kickoffAt: l.kickoffAt ? new Date(l.kickoffAt) : null,
            marketId: l.marketId,
            marketDesc: l.marketDesc,
            marketKind: marketKind(l.marketId, l.marketDesc),
            outcomeId: l.outcomeId,
            outcomeDesc: l.outcomeDesc,
            specifier: l.specifier ?? null,
            odds: l.odds,
            impliedProb: l.impliedProb ?? 1 / l.odds,
            confidence: l.confidence ?? l.impliedProb ?? 1 / l.odds,
            edge: l.edge ?? 0,
            reasoning:
              l.reasoning ??
              `Remixed pick: ${l.outcomeDesc} @ ${l.odds.toFixed(2)} on ${l.homeTeam} vs ${l.awayTeam}.`,
          })),
        },
      },
      include: { picks: { orderBy: { kickoffAt: "asc" } } },
    })

    return NextResponse.json({
      ok: true,
      slip,
      parent: { id: source.id, shareCode: source.shareCode },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Remix failed"
    return NextResponse.json({ ok: false, error: message }, { status: 502 })
  }
}
