import { NextResponse } from "next/server"
import { z } from "zod"
import { generateForecastSlip } from "@/lib/forecast/run"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const bodySchema = z.object({
  legCount: z.number().int().min(2).max(40).optional(),
  minOdds: z.number().min(1.01).max(50).optional(),
  maxOdds: z.number().min(1.01).max(50).optional(),
  country: z.string().min(2).max(4).optional(),
  bookmaker: z.enum(["sportybet", "football"]).optional(),
  createCode: z.boolean().optional(),
  useAi: z.boolean().optional(),
  label: z.string().max(120).optional(),
  markets: z
    .array(z.enum(["match_result", "over_under", "btts", "any"]))
    .optional(),
  maxHoursAhead: z.number().min(1).max(336).optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** 0-1, e.g. 0.7 for ~70% chance picks */
  minConfidence: z.number().min(0.5).max(0.95).optional(),
  preferHighProbability: z.boolean().optional(),
})

export async function POST(request: Request) {
  try {
    const json = await request.json().catch(() => ({}))
    const parsed = bodySchema.safeParse(json)
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const result = await generateForecastSlip(parsed.data)

    return NextResponse.json({
      ok: true,
      eventCount: result.eventCount,
      candidateCount: result.candidateCount,
      formHits: result.formHits,
      aiEnabled: result.aiEnabled,
      researchPoolSize: result.researchPoolSize,
      dateFrom: result.dateFrom,
      dateTo: result.dateTo,
      minConfidence: result.minConfidence,
      runId: result.run.id,
      engine: result.aiEnabled
        ? "high_prob_shortlist_ai_select"
        : "high_prob_poisson_form",
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
        picks: result.slip.picks.map((p) => ({
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
    const message = err instanceof Error ? err.message : "Forecast failed"
    return NextResponse.json({ ok: false, error: message }, { status: 502 })
  }
}
