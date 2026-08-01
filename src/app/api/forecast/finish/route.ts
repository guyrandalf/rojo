import { NextResponse } from "next/server"
import { z } from "zod"
import { finishForecastRun } from "@/lib/forecast/session"
import { humanError } from "../errors"

export const dynamic = "force-dynamic"

const bodySchema = z.object({
  runId: z.string().min(1),
  legCount: z.number().int().min(2).max(10).optional(),
  targetOdds: z.number().min(1.2).max(2000).optional(),
  createCode: z.boolean().optional(),
  label: z.string().max(120).optional(),
})

export async function POST(request: Request) {
  try {
    const json = await request.json().catch(() => ({}))
    const parsed = bodySchema.safeParse(json)
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "Bad finish request.", details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const { runId, ...rest } = parsed.data
    const result = await finishForecastRun(runId, rest)

    return NextResponse.json({
      ok: true,
      eventCount: result.eventCount,
      candidateCount: result.candidateCount,
      formHits: result.formHits,
      dateFrom: result.dateFrom,
      dateTo: result.dateTo,
      minConfidence: result.minConfidence,
      requestedLegs: result.requestedLegs,
      deliveredLegs: result.deliveredLegs,
      bestEffort: result.bestEffort,
      warnings: result.warnings,
      runId: result.runId,
      engine: "deep_markets_conviction",
      slip: {
        id: result.slip.id,
        status: result.slip.status,
        label: result.slip.label,
        totalOdds: result.slip.totalOdds,
        combinedConf: result.slip.combinedConf,
        shareCode: result.slip.shareCode,
        shareUrl: result.slip.shareUrl,
        bookmaker: result.slip.bookmaker,
        country: result.slip.country,
        notes: result.slip.notes,
        picks: (
          result.slip.picks as Array<{
            id: string
            homeTeam: string
            awayTeam: string
            tournament: string | null
            kickoffAt: Date | string | null
            marketDesc: string
            outcomeDesc: string
            odds: number
            confidence: number
            edge: number | null
            reasoning: string | null
          }>
        ).map((p) => ({
          id: p.id,
          homeTeam: p.homeTeam,
          awayTeam: p.awayTeam,
          tournament: p.tournament,
          kickoffAt: p.kickoffAt,
          marketDesc: p.marketDesc,
          outcomeDesc: p.outcomeDesc,
          odds: p.odds,
          confidence: p.confidence,
          edge: p.edge,
          reasoning: p.reasoning,
        })),
      },
    })
  } catch (err) {
    const { status, error } = humanError(err)
    return NextResponse.json({ ok: false, error }, { status })
  }
}
