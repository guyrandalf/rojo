import "server-only"
import { db } from "@/lib/db"
import { MarketKind } from "@/generated/prisma/client"
import {
  createShareCode,
  fetchUpcomingBoard,
} from "@/lib/sporty/client"
import type { Bookmaker, CandidatePick, SportySelection } from "@/lib/sporty/types"
import { isAiConfigured, selectPicksWithAi } from "./ai"
import { enrichMatchesWithForm } from "./form"
import {
  addDaysYmd,
  buildCandidates,
  combinedConfidence,
  combinedOdds,
  selectLegs,
  todayYmd,
  type ForecastOptions,
} from "./model"

function toMarketKind(marketId: string, desc: string): MarketKind {
  const d = desc.toLowerCase()
  if (marketId === "1" || d.includes("1x2")) return MarketKind.MATCH_RESULT
  if (marketId === "18" || d.includes("over/under") || d.includes("total")) {
    return MarketKind.OVER_UNDER
  }
  if (marketId === "29" || d.includes("both teams") || d.includes("btts")) {
    return MarketKind.BTTS
  }
  if (d.includes("double chance")) return MarketKind.DOUBLE_CHANCE
  return MarketKind.OTHER
}

function humanizeStatsReason(p: CandidatePick): string {
  const conf = (p.confidence * 100).toFixed(0)
  const bookPct = (p.impliedProb * 100).toFixed(0)
  const chance = (Math.max(p.impliedProb, p.confidence) * 100).toFixed(0)

  return [
    `Pick ${p.outcomeDesc} on ${p.homeTeam} vs ${p.awayTeam} (${p.marketDesc}) at ${p.odds.toFixed(2)}.`,
    `Book price implies ~${bookPct}% chance; model confidence ~${conf}%; selection chance ~${chance}%.`,
    p.reasoning,
    "Ranking is statistical only.",
  ].join(" ")
}

export type GenerateSlipInput = ForecastOptions & {
  country?: string
  bookmaker?: Bookmaker
  createCode?: boolean
  label?: string
  useAi?: boolean
  useForm?: boolean
}

export type GenerateSlipResult = {
  // Prisma include shape — kept loose so slip.picks is always available
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

export async function generateForecastSlip(
  input: GenerateSlipInput = {}
): Promise<GenerateSlipResult> {
  const requestedLegs = Math.min(Math.max(input.legCount ?? 5, 2), 40)
  const country = input.country ?? process.env.SPORTY_COUNTRY ?? "ng"
  const bookmaker: Bookmaker =
    input.bookmaker ??
    (process.env.DEFAULT_BOOKMAKER === "football" ? "football" : "sportybet")
  const createCode = input.createCode !== false
  const useForm = input.useForm !== false
  const warnings: string[] = []

  // Big tickets: skip AI so Netlify does not time out
  const bigTicket = requestedLegs > 10
  const wantAi = input.useAi === true && !bigTicket
  if (input.useAi === true && bigTicket) {
    warnings.push(
      "Help me pick better was skipped for big tickets (more than 10 games) so the code can finish faster."
    )
  }

  const dateFrom = input.dateFrom ?? todayYmd()
  const dateTo = input.dateTo ?? addDaysYmd(dateFrom, 2)
  const minConfidence = input.minConfidence ?? 0.6
  const preferHighProbability = input.preferHighProbability !== false
  const maxOdds =
    input.maxOdds ?? Math.min(2.05, 1 / Math.max(0.48, minConfidence - 0.08))
  const minOdds = input.minOdds ?? 1.18

  // Fewer pages on huge requests to stay under serverless time limits
  const maxPages = requestedLegs >= 15 ? 6 : 8

  const events = await fetchUpcomingBoard({
    country,
    bookmaker,
    marketIds: "1,18,29",
    maxPages,
    pageSize: 40,
  })

  const forecastOpts: ForecastOptions = {
    legCount: requestedLegs,
    minOdds,
    maxOdds,
    markets: input.markets,
    maxHoursAhead: input.maxHoursAhead ?? 336,
    dateFrom,
    dateTo,
    minConfidence,
    preferHighProbability,
  }

  const draft = buildCandidates(events, forecastOpts)

  // Cap shortlist / form work so 20-game runs do not explode
  const shortlistSize = Math.min(
    Math.max(requestedLegs * 3, 16),
    bigTicket ? 36 : 60
  )
  const shortlist = selectLegs(draft, shortlistSize, { preferHighProbability })
  const shortlistIds = new Set(shortlist.map((p) => p.eventId))
  const formTargets = events
    .filter((e) => shortlistIds.has(e.eventId))
    .slice(0, bigTicket ? 10 : 16)
    .map((e) => ({
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

  const candidates = buildCandidates(events, forecastOpts, formByEvent)
  const researchPool = selectLegs(candidates, shortlistSize, {
    preferHighProbability,
  })

  let picks: CandidatePick[] = []
  let aiEnabled = false
  let aiOverview: string | undefined
  let modelNotes = ""

  if (wantAi && isAiConfigured()) {
    const aiTarget = Math.min(requestedLegs, 10)
    const ai = await selectPicksWithAi(researchPool, aiTarget)
    aiEnabled = ai.aiEnabled
    aiOverview = ai.overview
    if (ai.picks.length >= 2) {
      picks = ai.picks
      modelNotes = [
        `Window ${dateFrom} → ${dateTo}. Target chance ≥${(minConfidence * 100).toFixed(0)}%.`,
        "Board scan → shortlist → extra help → booking code.",
        ai.notes,
        formHits > 0
          ? `Form/H2H on ${formHits}/${formTargets.length} matches.`
          : "Form/H2H sparse.",
      ]
        .filter(Boolean)
        .join(" ")
    } else {
      picks = selectLegs(candidates, requestedLegs, {
        preferHighProbability,
      }).map((p) => ({
        ...p,
        reasoning: humanizeStatsReason(p),
      }))
      modelNotes = [
        `Window ${dateFrom} → ${dateTo}. Target chance ≥${(minConfidence * 100).toFixed(0)}%.`,
        "Extra help could not finish; used normal ranking.",
        ai.notes,
      ]
        .filter(Boolean)
        .join(" ")
      aiEnabled = false
      warnings.push("Extra help failed; used normal pick ranking.")
    }
  } else {
    picks = selectLegs(candidates, requestedLegs, {
      preferHighProbability,
    }).map((p) => ({
      ...p,
      reasoning: humanizeStatsReason(p),
    }))
    modelNotes =
      input.useAi === true && !wantAi
        ? `Window ${dateFrom} → ${dateTo}. Target ≥${(minConfidence * 100).toFixed(0)}%. Stats ranking (big ticket).`
        : input.useAi === true
          ? `Window ${dateFrom} → ${dateTo}. Target ≥${(minConfidence * 100).toFixed(0)}%. Help key missing; stats ranking only.`
          : `Window ${dateFrom} → ${dateTo}. Target ≥${(minConfidence * 100).toFixed(0)}%. Stats ranking.`
    if (formHits > 0) {
      modelNotes += ` Form/H2H on ${formHits}/${formTargets.length} shortlisted.`
    }
  }

  // Best effort: deliver what we can if at least 2 legs, even if less than requested
  if (picks.length < 2) {
    throw new Error(
      `Not enough strong games in ${dateFrom} → ${dateTo}. ` +
        `Found ${picks.length} (need at least 2). ` +
        `Checked ${events.length} matches, ${candidates.length} outcomes at ≥${(minConfidence * 100).toFixed(0)}%. ` +
        `Try: fewer games, lower strength %, bigger odds range, or more days.`
    )
  }

  const bestEffort = picks.length < requestedLegs
  if (bestEffort) {
    warnings.push(
      `You asked for ${requestedLegs} games but only ${picks.length} strong enough picks were on the board. Ticket built with ${picks.length}.`
    )
    modelNotes += ` Best effort: ${picks.length}/${requestedLegs} games.`
  }

  if (aiOverview) {
    modelNotes = `${aiOverview} | ${modelNotes}`
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
      minOdds,
      maxOdds,
      strategy: aiEnabled
        ? "high_prob_shortlist_ai_select"
        : bestEffort
          ? "high_prob_best_effort"
          : "high_prob_poisson_form",
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
      warnings.push(
        `Ticket saved but booking code failed: ${msg}. Try again or change betting site.`
      )
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
    eventCount: events.length,
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
