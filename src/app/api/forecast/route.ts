import { NextResponse } from "next/server"
import { z } from "zod"
import { generateForecastSlip } from "@/lib/forecast/run"

export const dynamic = "force-dynamic"
export const maxDuration = 60

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
  minConfidence: z.number().min(0.5).max(0.95).optional(),
  preferHighProbability: z.boolean().optional(),
})

function humanError(err: unknown): { status: number; error: string } {
  const message = err instanceof Error ? err.message : "Could not make code"

  if (/not enough strong games|not enough high-probability|found 0 picks/i.test(message)) {
    return { status: 422, error: message }
  }
  if (
    /timed out|timeout|ETIMEDOUT/i.test(message) ||
    /UND_ERR_CONNECT/i.test(message)
  ) {
    return {
      status: 504,
      error:
        "Took too long. Try fewer games, turn off “Help me pick better”, or use a shorter day range.",
    }
  }
  if (/Could not load fixtures|ECONNREFUSED|fetch failed|network/i.test(message)) {
    return {
      status: 502,
      error:
        "Could not reach the betting site board. Try again in a minute, or switch betting site.",
    }
  }
  if (/Could not create booking code/i.test(message)) {
    return { status: 502, error: message }
  }

  return { status: 502, error: message }
}

export async function POST(request: Request) {
  try {
    const json = await request.json().catch(() => ({}))
    const parsed = bodySchema.safeParse(json)
    if (!parsed.success) {
      return NextResponse.json(
        {
          ok: false,
          error: "Some settings look wrong. Check games, odds, and dates.",
          details: parsed.error.flatten(),
        },
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
      requestedLegs: result.requestedLegs,
      deliveredLegs: result.deliveredLegs,
      bestEffort: result.bestEffort,
      warnings: result.warnings,
      runId: result.run.id,
      engine: result.aiEnabled
        ? "high_prob_shortlist_ai_select"
        : result.bestEffort
          ? "high_prob_best_effort"
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
