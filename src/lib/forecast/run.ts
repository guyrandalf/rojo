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
    "No large language model reviewed this leg; ranking is statistical only.",
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

export async function generateForecastSlip(input: GenerateSlipInput = {}) {
  const legCount = Math.min(Math.max(input.legCount ?? 5, 2), 12)
  const country = input.country ?? process.env.SPORTY_COUNTRY ?? "ng"
  const bookmaker: Bookmaker =
    input.bookmaker ??
    (process.env.DEFAULT_BOOKMAKER === "football" ? "football" : "sportybet")
  const createCode = input.createCode !== false
  const useForm = input.useForm !== false
  const wantAi = input.useAi !== false

  const dateFrom = input.dateFrom ?? todayYmd()
  const dateTo = input.dateTo ?? addDaysYmd(dateFrom, 2)
  // Lenient defaults: room for more board legs without forcing ultra-shorts
  const minConfidence = input.minConfidence ?? 0.6
  const preferHighProbability = input.preferHighProbability !== false
  const maxOdds =
    input.maxOdds ?? Math.min(2.05, 1 / Math.max(0.48, minConfidence - 0.08))
  const minOdds = input.minOdds ?? 1.18

  // Crawl many pages — feed is not chronological; today often sits on later pages.
  const events = await fetchUpcomingBoard({
    country,
    bookmaker,
    marketIds: "1,18,29",
    maxPages: 8,
    pageSize: 40,
  })

  const forecastOpts: ForecastOptions = {
    legCount,
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

  const shortlistSize = Math.min(Math.max(legCount * 5, 16), 28)
  const shortlist = selectLegs(draft, shortlistSize, { preferHighProbability })
  const shortlistIds = new Set(shortlist.map((p) => p.eventId))
  const formTargets = events
    .filter((e) => shortlistIds.has(e.eventId))
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
    const ai = await selectPicksWithAi(researchPool, legCount)
    aiEnabled = ai.aiEnabled
    aiOverview = ai.overview
    if (ai.picks.length >= Math.min(2, legCount)) {
      picks = ai.picks
      modelNotes = [
        `Window ${dateFrom} → ${dateTo}. Target chance ≥${(minConfidence * 100).toFixed(0)}%.`,
        "Pipeline: multi-page board → Poisson+form shortlist → AI final legs → booking code.",
        ai.notes,
        formHits > 0
          ? `Form/H2H on ${formHits}/${formTargets.length} matches.`
          : "Form/H2H sparse.",
      ]
        .filter(Boolean)
        .join(" ")
    } else {
      picks = selectLegs(candidates, legCount, { preferHighProbability }).map(
        (p) => ({
          ...p,
          reasoning: humanizeStatsReason(p),
        })
      )
      modelNotes = [
        `Window ${dateFrom} → ${dateTo}. Target chance ≥${(minConfidence * 100).toFixed(0)}%.`,
        "AI could not finalize; used high-probability stats ranking.",
        ai.notes,
      ]
        .filter(Boolean)
        .join(" ")
      aiEnabled = false
    }
  } else {
    picks = selectLegs(candidates, legCount, { preferHighProbability }).map(
      (p) => ({
        ...p,
        reasoning: humanizeStatsReason(p),
      })
    )
    modelNotes = wantAi
      ? `Window ${dateFrom} → ${dateTo}. Target chance ≥${(minConfidence * 100).toFixed(0)}%. XAI_API_KEY missing: stats high-prob ranking only.`
      : `Window ${dateFrom} → ${dateTo}. Target chance ≥${(minConfidence * 100).toFixed(0)}%. Stats high-prob ranking.`
    if (formHits > 0) {
      modelNotes += ` Form/H2H on ${formHits}/${formTargets.length} shortlisted.`
    }
  }

  if (picks.length < Math.min(2, legCount)) {
    throw new Error(
      `Not enough high-probability fixtures in ${dateFrom} → ${dateTo} ` +
        `(found ${picks.length} picks from ${events.length} board events / ${candidates.length} outcomes ≥${(minConfidence * 100).toFixed(0)}%). ` +
        `Widen the date range, lower min chance, or raise max odds slightly.`
    )
  }

  if (aiOverview) {
    modelNotes = `${aiOverview} | ${modelNotes}`
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
      modelNotes = [
        modelNotes,
        err instanceof Error ? `Code create failed: ${err.message}` : "Code create failed",
      ].join(" | ")
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
  }
}
