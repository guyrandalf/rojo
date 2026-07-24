import "server-only"
import { db } from "@/lib/db"
import { MarketKind } from "@/generated/prisma/client"
import {
  createShareCode,
  enrichEventsWithFullMarkets,
  fetchUpcomingBoard,
} from "@/lib/sporty/client"
import type { Bookmaker, CandidatePick, SportyEvent, SportySelection } from "@/lib/sporty/types"
import { isAiConfigured, selectPicksWithAi } from "./ai"
import { enrichMatchesWithForm } from "./form"
import {
  addDaysYmd,
  buildCandidates,
  combinedConfidence,
  combinedOdds,
  localDayBounds,
  selectLegs,
  todayYmd,
  type ForecastOptions,
} from "./model"

function toMarketKind(marketId: string, desc: string): MarketKind {
  const d = desc.toLowerCase()
  if (marketId === "1" || marketId === "219" || d.includes("1x2") || d.includes("winner")) {
    return MarketKind.MATCH_RESULT
  }
  if (
    marketId === "18" ||
    d.includes("over/under") ||
    d.includes("total")
  ) {
    return MarketKind.OVER_UNDER
  }
  if (marketId === "29" || d.includes("both teams") || d.includes("btts")) {
    return MarketKind.BTTS
  }
  if (d.includes("double chance")) return MarketKind.DOUBLE_CHANCE
  return MarketKind.OTHER
}

function humanizeStatsReason(p: CandidatePick): string {
  return [
    `${p.outcomeDesc} on ${p.homeTeam} vs ${p.awayTeam} (${p.marketDesc}) @ ${p.odds.toFixed(2)}.`,
    `Conviction ${(p.confidence * 100).toFixed(0)}% (analysis, not “short odds = sure”).`,
    p.reasoning,
  ].join(" ")
}

export type GenerateSlipInput = ForecastOptions & {
  country?: string
  bookmaker?: Bookmaker
  createCode?: boolean
  label?: string
  /** Ignored — AI is always on when key is present; required in product */
  useAi?: boolean
  useForm?: boolean
  includeBasketball?: boolean
}

export type GenerateSlipResult = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  slip: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: any
  candidateCount: number
  eventCount: number
  formHits: number
  aiEnabled: boolean
  researchPoolSize: number
  dateFrom: string
  dateTo: string
  minConfidence: number
  requestedLegs: number
  deliveredLegs: number
  bestEffort: boolean
  warnings: string[]
}

function filterEventsByDate(
  events: SportyEvent[],
  dateFrom: string,
  dateTo: string
): SportyEvent[] {
  const start = localDayBounds(dateFrom).start
  const end = localDayBounds(dateTo).end
  const now = Date.now() + 15 * 60 * 1000
  return events.filter((e) => {
    const t = e.estimateStartTime
    return t >= Math.max(start, now) && t <= end
  })
}

export async function generateForecastSlip(
  input: GenerateSlipInput = {}
): Promise<GenerateSlipResult> {
  // Hard product cap: 10 games max, default 10
  const requestedLegs = Math.min(Math.max(input.legCount ?? 10, 2), 10)
  const country = input.country ?? process.env.SPORTY_COUNTRY ?? "ng"
  const bookmaker: Bookmaker =
    input.bookmaker ??
    (process.env.DEFAULT_BOOKMAKER === "football" ? "football" : "sportybet")
  const createCode = input.createCode !== false
  const useForm = input.useForm !== false
  const includeBasketball = input.includeBasketball === true
  const warnings: string[] = []

  if (!isAiConfigured()) {
    throw new Error(
      "Play Rojo needs AI analysis on. Set XAI_API_KEY on the server (Netlify env). This cannot be turned off."
    )
  }

  const dateFrom = input.dateFrom ?? todayYmd()
  const dateTo = input.dateTo ?? addDaysYmd(dateFrom, 2)
  // Conviction floor — not an odds filter
  const minConfidence = input.minConfidence ?? 0.58
  const preferHighProbability = true

  // Seed board: main markets to discover events
  const footballBoard = await fetchUpcomingBoard({
    country,
    bookmaker,
    sportId: "sr:sport:1",
    marketIds: "1,10,11,18,29,60",
    maxPages: 7,
    pageSize: 40,
  })

  let basketballBoard: SportyEvent[] = []
  if (includeBasketball) {
    basketballBoard = await fetchUpcomingBoard({
      country,
      bookmaker,
      sportId: "sr:sport:2",
      marketIds: "219,18,223,225",
      maxPages: 4,
      pageSize: 40,
    }).catch(() => [])
    if (basketballBoard.length === 0) {
      warnings.push("Basketball board empty or blocked; football only this run.")
    }
  }

  const dated = filterEventsByDate(
    [...footballBoard, ...basketballBoard],
    dateFrom,
    dateTo
  )

  // Deep dive: full market board for soonest events in window
  const seedSorted = [...dated].sort(
    (a, b) => a.estimateStartTime - b.estimateStartTime
  )
  const deepTargets = seedSorted.slice(0, 28)
  const deepEvents = await enrichEventsWithFullMarkets(deepTargets, {
    country,
    bookmaker,
    concurrency: 5,
  })

  const forecastOpts: ForecastOptions = {
    legCount: requestedLegs,
    // No odds clamp — analysis only
    minOdds: 1.01,
    maxOdds: 80,
    markets: ["any"],
    maxHoursAhead: input.maxHoursAhead ?? 336,
    dateFrom,
    dateTo,
    minConfidence,
    preferHighProbability,
  }

  // Form on a subset of deep events
  const formTargets = deepEvents.slice(0, 14).map((e) => ({
    eventId: e.eventId,
    homeTeam: e.homeTeamName,
    awayTeam: e.awayTeamName,
  }))

  let formByEvent:
    | Awaited<ReturnType<typeof enrichMatchesWithForm>>
    | undefined
  let formHits = 0
  if (useForm && formTargets.length > 0) {
    formByEvent = await enrichMatchesWithForm(formTargets)
    for (const v of formByEvent.values()) {
      if (v.homeForm || v.awayForm || v.h2h) formHits++
    }
  }

  const candidates = buildCandidates(deepEvents, forecastOpts, formByEvent)
  const shortlistSize = Math.min(Math.max(requestedLegs * 4, 20), 40)
  const researchPool = selectLegs(candidates, shortlistSize, {
    preferHighProbability,
  })

  const ai = await selectPicksWithAi(researchPool, requestedLegs)
  let picks: CandidatePick[] = []
  let aiEnabled = ai.aiEnabled
  let modelNotes = ""

  if (ai.picks.length >= 2) {
    picks = ai.picks
    modelNotes = [
      `Window ${dateFrom} → ${dateTo}. Conviction ≥${(minConfidence * 100).toFixed(0)}% (analysis, not odds filter).`,
      "Deep markets + form → AI chooses final ticket.",
      ai.notes,
      ai.overview,
      formHits > 0
        ? `Form/H2H on ${formHits}/${formTargets.length} matches.`
        : null,
      includeBasketball ? "Basketball included when available." : "Football only.",
    ]
      .filter(Boolean)
      .join(" ")
  } else {
    // Fallback stats if AI returns junk — still best effort
    picks = selectLegs(candidates, requestedLegs, {
      preferHighProbability,
    }).map((p) => ({ ...p, reasoning: humanizeStatsReason(p) }))
    aiEnabled = false
    warnings.push(
      "AI could not finish cleanly; used analysis ranking only. Check XAI_API_KEY if this keeps happening."
    )
    modelNotes = [
      `Window ${dateFrom} → ${dateTo}.`,
      ai.notes,
      warnings[warnings.length - 1],
    ]
      .filter(Boolean)
      .join(" ")
  }

  if (picks.length < 2) {
    throw new Error(
      `Not enough high-conviction picks in ${dateFrom} → ${dateTo}. ` +
        `Found ${picks.length} (need 2+). Deep-scanned ${deepEvents.length} matches, ` +
        `${candidates.length} market outcomes ≥${(minConfidence * 100).toFixed(0)}%. ` +
        `Try more days, lower strength %, or include basketball.`
    )
  }

  const bestEffort = picks.length < requestedLegs
  if (bestEffort) {
    warnings.push(
      `You wanted ${requestedLegs} games; only ${picks.length} passed analysis. Ticket uses ${picks.length}.`
    )
  }

  if (warnings.length) {
    modelNotes = `${warnings.join(" ")} | ${modelNotes}`
  }

  const totalOdds = combinedOdds(picks)
  const combinedConf = combinedConfidence(picks)

  const run = await db.forecastRun.create({
    data: {
      country,
      legCount: picks.length,
      minOdds: null,
      maxOdds: null,
      strategy: aiEnabled
        ? "deep_markets_ai_conviction"
        : "deep_markets_stats_fallback",
      modelNotes,
      aiEnabled,
    },
  })

  let shareCode: string | null = null
  let shareUrl: string | null = null

  if (createCode) {
    const selections: SportySelection[] = picks.map((p) => ({
      eventId: p.eventId,
      marketId: p.marketId,
      outcomeId: p.outcomeId,
      specifier: p.specifier,
    }))

    try {
      const created = await createShareCode(selections, { country, bookmaker })
      shareCode = created.shareCode
      shareUrl = created.shareURL
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Could not create booking code"
      modelNotes = `${modelNotes} | Code create failed: ${msg}`
      warnings.push(`Ticket saved but booking code failed: ${msg}`)
    }
  }

  const slip = await db.betSlip.create({
    data: {
      status: shareCode ? "CODED" : "DRAFT",
      label: input.label ?? `Play Rojo · ${picks.length} games`,
      totalOdds,
      combinedConf,
      shareCode,
      shareUrl,
      bookmaker,
      country,
      forecastRunId: run.id,
      notes: modelNotes,
      picks: {
        create: picks.map((p: CandidatePick) => ({
          eventId: p.eventId,
          gameId: p.gameId ?? null,
          homeTeam: p.homeTeam,
          awayTeam: p.awayTeam,
          tournament: p.tournament ?? null,
          kickoffAt: p.kickoffAt,
          marketId: p.marketId,
          marketDesc: p.marketDesc,
          marketKind: toMarketKind(p.marketId, p.marketDesc),
          outcomeId: p.outcomeId,
          outcomeDesc: p.outcomeDesc,
          specifier: p.specifier,
          odds: p.odds,
          impliedProb: p.impliedProb,
          confidence: p.confidence,
          edge: p.edge,
          reasoning: p.reasoning,
          sourceOdds: p.sourceOdds,
        })),
      },
    },
    include: { picks: { orderBy: { kickoffAt: "asc" } } },
  })

  return {
    slip,
    run,
    candidateCount: candidates.length,
    eventCount: deepEvents.length,
    formHits,
    aiEnabled,
    researchPoolSize: researchPool.length,
    dateFrom,
    dateTo,
    minConfidence,
    requestedLegs,
    deliveredLegs: picks.length,
    bestEffort,
    warnings,
  }
}
