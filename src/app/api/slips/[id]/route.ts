import { NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { createShareCode, fetchEventDetail } from "@/lib/sporty/client"
import type { Bookmaker, SportyEvent, SportyMarket } from "@/lib/sporty/types"

export const dynamic = "force-dynamic"

type Params = { params: Promise<{ id: string }> }

function boardFromEvent(event: SportyEvent) {
  const markets = (event.markets ?? [])
    .filter((m) => m.status === 0)
    .map((m: SportyMarket) => {
      const line =
        m.specifier?.match(/total[=:]?\s*([0-9.]+)/i)?.[1] ??
        m.desc.match(/([0-9]+(?:\.[0-9]+)?)/)?.[1] ??
        null
      return {
        marketId: m.id,
        marketDesc: m.desc,
        specifier: m.specifier ?? null,
        line,
        outcomes: (m.outcomes ?? [])
          .filter((o) => o.isActive === 1)
          .map((o) => ({
            outcomeId: o.id,
            outcomeDesc: o.desc,
            odds: Number(o.odds),
            probability: o.probability ? Number(o.probability) : null,
          }))
          .filter((o) => Number.isFinite(o.odds) && o.odds > 1),
      }
    })
    .filter((m) => m.outcomes.length > 0)

  // Prefer main families first in UI
  const rank = (id: string, desc: string) => {
    if (id === "1" || /1x2/i.test(desc)) return 0
    if (id === "18" || /over\/under|total/i.test(desc)) return 1
    if (id === "29" || /both teams|btts|gg/i.test(desc)) return 2
    return 9
  }
  markets.sort(
    (a, b) =>
      rank(a.marketId, a.marketDesc) - rank(b.marketId, b.marketDesc) ||
      a.marketDesc.localeCompare(b.marketDesc)
  )

  return {
    eventId: event.eventId,
    homeTeam: event.homeTeamName,
    awayTeam: event.awayTeamName,
    kickoffAt: event.estimateStartTime
      ? new Date(event.estimateStartTime).toISOString()
      : null,
    tournament: event.sport?.category?.tournament?.name ?? null,
    markets,
  }
}

export async function GET(request: Request, { params }: Params) {
  try {
    const { id } = await params
    const { searchParams } = new URL(request.url)
    const withBoard = searchParams.get("board") === "1"

    const slip = await db.betSlip.findUnique({
      where: { id },
      include: { picks: { orderBy: { kickoffAt: "asc" } } },
    })

    if (!slip) {
      return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 })
    }

    if (!withBoard) {
      return NextResponse.json({ ok: true, slip })
    }

    const country = slip.country
    const bookmaker = (slip.bookmaker === "football" ? "football" : "sportybet") as Bookmaker
    const uniqueEventIds = [...new Set(slip.picks.map((p) => p.eventId))]

    const boards: Record<string, ReturnType<typeof boardFromEvent> | null> = {}

    await Promise.all(
      uniqueEventIds.map(async (eventId) => {
        const event = await fetchEventDetail(eventId, { country, bookmaker: "sportybet" })
        boards[eventId] = event ? boardFromEvent(event) : null
      })
    )

    // Fallback: sourceOdds snapshot on the pick when live board missing
    const legs = slip.picks.map((p) => {
      const live = boards[p.eventId]
      let markets = live?.markets ?? []

      if (markets.length === 0 && p.sourceOdds && typeof p.sourceOdds === "object") {
        const snap = p.sourceOdds as Record<string, number>
        markets = [
          {
            marketId: p.marketId,
            marketDesc: p.marketDesc,
            specifier: p.specifier,
            line: null,
            outcomes: Object.entries(snap).map(([outcomeDesc, odds], idx) => ({
              outcomeId:
                outcomeDesc === p.outcomeDesc ? p.outcomeId : `snap-${idx}`,
              outcomeDesc,
              odds: Number(odds),
              probability: null,
              snapshotOnly: true as const,
            })),
          },
        ]
      }

      return {
        pickId: p.id,
        eventId: p.eventId,
        homeTeam: p.homeTeam,
        awayTeam: p.awayTeam,
        tournament: p.tournament,
        kickoffAt: p.kickoffAt,
        selected: {
          marketId: p.marketId,
          marketDesc: p.marketDesc,
          outcomeId: p.outcomeId,
          outcomeDesc: p.outcomeDesc,
          specifier: p.specifier,
          odds: p.odds,
          confidence: p.confidence,
          edge: p.edge,
          reasoning: p.reasoning,
        },
        markets,
        live: Boolean(live && live.markets.length > 0),
      }
    })

    return NextResponse.json({
      ok: true,
      slip,
      legs,
      bookmaker,
      country,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load slip"
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}

const patchSchema = z.object({
  status: z
    .enum(["DRAFT", "CODED", "STAKED", "WON", "LOST", "VOID", "EXPIRED"])
    .optional(),
  regenerateCode: z.boolean().optional(),
  bookmaker: z.enum(["sportybet", "football"]).optional(),
})

export async function PATCH(request: Request, { params }: Params) {
  try {
    const { id } = await params
    const json = await request.json().catch(() => ({}))
    const parsed = patchSchema.safeParse(json)
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const existing = await db.betSlip.findUnique({
      where: { id },
      include: { picks: true },
    })
    if (!existing) {
      return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 })
    }

    let shareCode = existing.shareCode
    let shareUrl = existing.shareUrl
    let status = parsed.data.status ?? existing.status
    const bookmaker = (parsed.data.bookmaker ?? existing.bookmaker) as Bookmaker

    if (parsed.data.regenerateCode) {
      const created = await createShareCode(
        existing.picks.map((p) => ({
          eventId: p.eventId,
          marketId: p.marketId,
          outcomeId: p.outcomeId,
          specifier: p.specifier,
        })),
        { country: existing.country, bookmaker }
      )
      shareCode = created.shareCode
      shareUrl = created.shareURL
      status = "CODED"
    }

    const slip = await db.betSlip.update({
      where: { id },
      data: {
        status,
        shareCode,
        shareUrl,
        bookmaker,
      },
      include: { picks: { orderBy: { kickoffAt: "asc" } } },
    })

    return NextResponse.json({ ok: true, slip })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Update failed"
    return NextResponse.json({ ok: false, error: message }, { status: 502 })
  }
}
