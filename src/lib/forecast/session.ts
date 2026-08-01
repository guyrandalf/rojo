import "server-only"
import { db } from "@/lib/db"
import { MarketKind, RunStatus } from "@/generated/prisma/client"
import {
  createShareCode,
  fetchEventDetail,
  fetchUpcomingBoard,
} from "@/lib/sporty/client"
import type {
  Bookmaker,
  CandidatePick,
  SportyEvent,
  SportySelection,
} from "@/lib/sporty/types"
import { fetchFormBundle } from "./form"
import { pruneFormCache } from "./form-cache"
import {
  addDaysYmd,
  buildCandidatesForEvent,
  combinedConfidence,
  combinedOdds,
  forecastWindow,
  selectLegs,
  selectLegsForTargetOdds,
  todayYmd,
  type ForecastOptions,
} from "./model"

/**
 * A forecast run is split across many short requests so it never depends on one
 * function staying alive:
 *
 *   start  → scan the board, queue the fixtures worth analysing
 *   step   → analyse ONE fixture, persist its scored outcomes  (repeat)
 *   finish → rank everything persisted, build the ticket and booking code
 *
 * Each call is a couple of seconds, which fits inside Netlify's 10s
 * synchronous-function budget with room to spare. It also means the run is
 * resumable: a failed fixture is retried on its own instead of restarting the
 * whole board.
 */

/** Fixtures queued for per-match analysis. Not bounded by any request budget. */
const DEEP_TARGET_LIMIT = 36

/** Product cap: 10 games max. */
const MAX_LEGS = 10

function toMarketKind(marketId: string, desc: string): MarketKind {
  const d = desc.toLowerCase()
  if (marketId === "1" || marketId === "219" || d.includes("1x2") || d.includes("winner")) {
    return MarketKind.MATCH_RESULT
  }
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
  return [
    `${p.outcomeDesc} on ${p.homeTeam} vs ${p.awayTeam} (${p.marketDesc}) @ ${p.odds.toFixed(2)}.`,
    `Conviction ${(p.confidence * 100).toFixed(0)}% (analysis, not “short odds = sure”).`,
    p.reasoning,
  ].join(" ")
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []
}

// ---------------------------------------------------------------------------
// Phase 1 — scan
// ---------------------------------------------------------------------------

export type StartRunInput = {
  legCount?: number
  country?: string
  bookmaker?: Bookmaker
  dateFrom?: string
  dateTo?: string
  minConfidence?: number
  maxHoursAhead?: number
  useForm?: boolean
  includeBasketball?: boolean
}

export type StartRunResult = {
  runId: string
  eventIds: string[]
  boardSize: number
  dateFrom: string
  dateTo: string
  minConfidence: number
  requestedLegs: number
  warnings: string[]
}

export async function startForecastRun(
  input: StartRunInput = {}
): Promise<StartRunResult> {
  const requestedLegs = Math.min(Math.max(input.legCount ?? MAX_LEGS, 2), MAX_LEGS)
  const country = input.country ?? process.env.SPORTY_COUNTRY ?? "ng"
  const bookmaker: Bookmaker =
    input.bookmaker ??
    (process.env.DEFAULT_BOOKMAKER === "football" ? "football" : "sportybet")
  const useForm = input.useForm !== false
  const includeBasketball = input.includeBasketball === true
  const dateFrom = input.dateFrom ?? todayYmd()
  const dateTo = input.dateTo ?? addDaysYmd(dateFrom, 2)
  // Conviction floor — not an odds filter
  const minConfidence = input.minConfidence ?? 0.58
  const warnings: string[] = []

  await pruneFormCache()

  // Every page in one round trip: this request has a budget to respect, and
  // the feed is not chronologically ordered so we cannot stop early anyway.
  const footballBoard = await fetchUpcomingBoard({
    country,
    bookmaker,
    sportId: "sr:sport:1",
    marketIds: "1,10,11,18,29,60",
    maxPages: 7,
    pageSize: 40,
    pageConcurrency: 7,
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
      pageConcurrency: 4,
    }).catch(() => [])
    if (basketballBoard.length === 0) {
      warnings.push("Basketball board empty or blocked; football only this run.")
    }
  }

  const opts: ForecastOptions = {
    maxHoursAhead: input.maxHoursAhead ?? 336,
    dateFrom,
    dateTo,
  }
  const { start: windowStart, end: windowEnd } = forecastWindow(opts)

  const dated = [...footballBoard, ...basketballBoard]
    .filter((e) => e.estimateStartTime >= windowStart && e.estimateStartTime <= windowEnd)
    .sort((a, b) => a.estimateStartTime - b.estimateStartTime)

  const eventIds = dated.slice(0, DEEP_TARGET_LIMIT).map((e) => e.eventId)

  if (eventIds.length === 0) {
    throw new Error(
      `No matches found in ${dateFrom} → ${dateTo}. Try more days, or include basketball.`
    )
  }

  const run = await db.forecastRun.create({
    data: {
      country,
      bookmaker,
      legCount: requestedLegs,
      strategy: "deep_markets_conviction",
      status: RunStatus.ANALYZING,
      dateFrom,
      dateTo,
      minConfidence,
      useForm,
      includeBasketball,
      targetEventIds: eventIds,
      boardSize: dated.length,
      warnings,
    },
  })

  return {
    runId: run.id,
    eventIds,
    boardSize: dated.length,
    dateFrom,
    dateTo,
    minConfidence,
    requestedLegs,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Phase 2 — analyse one fixture
// ---------------------------------------------------------------------------

export type StepResult = {
  eventId: string
  homeTeam: string | null
  awayTeam: string | null
  candidatesAdded: number
  hadForm: boolean
  skipped: boolean
  note?: string
}

export async function analyzeEvent(
  runId: string,
  eventId: string
): Promise<StepResult> {
  const run = await db.forecastRun.findUnique({ where: { id: runId } })
  if (!run) throw new Error("Run not found. Start a new ticket.")

  // Only fixtures this run queued: the event id arrives from the client.
  const queued = readStringList(run.targetEventIds)
  if (!queued.includes(eventId)) {
    throw new Error("That match is not part of this run.")
  }

  const detail = await fetchEventDetail(eventId, {
    country: run.country,
    bookmaker: run.bookmaker as Bookmaker,
  })

  if (!detail?.markets?.length) {
    await db.forecastRun.update({
      where: { id: runId },
      data: { analyzedCount: { increment: 1 } },
    })
    return {
      eventId,
      homeTeam: null,
      awayTeam: null,
      candidatesAdded: 0,
      hadForm: false,
      skipped: true,
      note: "No market board available.",
    }
  }

  const form = run.useForm
    ? await fetchFormBundle(detail.homeTeamName, detail.awayTeamName)
    : {}
  const hadForm = Boolean(form.homeForm || form.awayForm || form.h2h)

  const opts: ForecastOptions = {
    legCount: run.legCount,
    minOdds: 1.01,
    maxOdds: 80,
    markets: ["any"],
    maxHoursAhead: 336,
    dateFrom: run.dateFrom ?? undefined,
    dateTo: run.dateTo ?? undefined,
    minConfidence: run.minConfidence,
    preferHighProbability: true,
  }

  const candidates = buildCandidatesForEvent(detail, opts, form)

  if (candidates.length > 0) {
    // skipDuplicates makes a retried step a no-op rather than a double insert.
    await db.candidate.createMany({
      data: candidates.map((c) => ({
        forecastRunId: runId,
        eventId: c.eventId,
        gameId: c.gameId ?? null,
        homeTeam: c.homeTeam,
        awayTeam: c.awayTeam,
        tournament: c.tournament ?? null,
        kickoffAt: c.kickoffAt,
        marketId: c.marketId,
        marketDesc: c.marketDesc,
        outcomeId: c.outcomeId,
        outcomeDesc: c.outcomeDesc,
        specifier: c.specifier ?? "",
        odds: c.odds,
        impliedProb: c.impliedProb,
        confidence: c.confidence,
        edge: c.edge,
        reasoning: c.reasoning,
        sourceOdds: c.sourceOdds,
      })),
      skipDuplicates: true,
    })
  }

  await db.forecastRun.update({
    where: { id: runId },
    data: {
      analyzedCount: { increment: 1 },
      formHits: hadForm ? { increment: 1 } : undefined,
    },
  })

  return {
    eventId,
    homeTeam: detail.homeTeamName,
    awayTeam: detail.awayTeamName,
    candidatesAdded: candidates.length,
    hadForm,
    skipped: false,
  }
}

// ---------------------------------------------------------------------------
// Phase 3 — rank, book, save
// ---------------------------------------------------------------------------

export type FinishRunInput = {
  createCode?: boolean
  label?: string
  /** Lower than the run's leg count if the punter changed their mind. */
  legCount?: number
  /**
   * Total odds the punter wants. When set, legs are chosen to reach this with
   * the least risk (games count becomes automatic, capped at legCount). When
   * absent, falls back to picking legCount highest-conviction legs.
   */
  targetOdds?: number
}

export type FinishRunResult = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  slip: any
  runId: string
  candidateCount: number
  eventCount: number
  formHits: number
  dateFrom: string
  dateTo: string
  minConfidence: number
  requestedLegs: number
  deliveredLegs: number
  bestEffort: boolean
  warnings: string[]
}

export async function finishForecastRun(
  runId: string,
  input: FinishRunInput = {}
): Promise<FinishRunResult> {
  const run = await db.forecastRun.findUnique({
    where: { id: runId },
    include: { candidates: true },
  })
  if (!run) throw new Error("Run not found. Start a new ticket.")

  const requestedLegs = Math.min(
    Math.max(input.legCount ?? run.legCount, 2),
    MAX_LEGS
  )
  const createCode = input.createCode !== false
  const warnings = readStringList(run.warnings)

  const pool: CandidatePick[] = run.candidates.map((c) => ({
    eventId: c.eventId,
    gameId: c.gameId ?? undefined,
    homeTeam: c.homeTeam,
    awayTeam: c.awayTeam,
    tournament: c.tournament ?? undefined,
    kickoffAt: c.kickoffAt ?? new Date(),
    marketId: c.marketId,
    marketDesc: c.marketDesc,
    outcomeId: c.outcomeId,
    outcomeDesc: c.outcomeDesc,
    specifier: c.specifier === "" ? null : c.specifier,
    odds: c.odds,
    impliedProb: c.impliedProb,
    confidence: c.confidence,
    edge: c.edge,
    reasoning: c.reasoning ?? "",
    sourceOdds: (c.sourceOdds ?? {}) as Record<string, number>,
  }))

  const analyzedEvents = new Set(pool.map((p) => p.eventId)).size
  const targetOdds = input.targetOdds

  let selected: CandidatePick[]
  let reachedTarget = true
  if (targetOdds) {
    const result = selectLegsForTargetOdds(pool, {
      targetOdds,
      maxLegs: requestedLegs,
    })
    selected = result.picks
    reachedTarget = result.reachedTarget
    if (!reachedTarget && selected.length >= 2) {
      const got = combinedOdds(selected)
      warnings.push(
        `Could not reach ${targetOdds.toFixed(1)} odds safely; best was ${got.toFixed(2)} with ${selected.length} games. Try more days or lower strength %.`
      )
    }
  } else {
    selected = selectLegs(pool, requestedLegs, { preferHighProbability: true })
  }

  const picks = selected.map((p) => ({
    ...p,
    reasoning: humanizeStatsReason(p),
  }))

  if (picks.length < 2) {
    await db.forecastRun.update({
      where: { id: runId },
      data: { status: RunStatus.FAILED },
    })
    throw new Error(
      `Not enough high-conviction picks in ${run.dateFrom} → ${run.dateTo}. ` +
        `Found ${picks.length} (need 2+). Analysed ${analyzedEvents} matches, ` +
        `${pool.length} market outcomes ≥${(run.minConfidence * 100).toFixed(0)}%. ` +
        `Try more days, lower strength %, or include basketball.`
    )
  }

  // In target-odds mode fewer legs is a feature (less risk for the same
  // payout), so best-effort only means the target itself was missed.
  const bestEffort = targetOdds
    ? !reachedTarget
    : picks.length < requestedLegs
  if (!targetOdds && bestEffort) {
    warnings.push(
      `You wanted ${requestedLegs} games; only ${picks.length} passed analysis. Ticket uses ${picks.length}.`
    )
  }

  let modelNotes = [
    targetOdds
      ? `Target ${targetOdds.toFixed(1)} odds → safest ${picks.length}-game route.`
      : null,
    `Window ${run.dateFrom} → ${run.dateTo}. Conviction ≥${(run.minConfidence * 100).toFixed(0)}% (analysis, not odds filter).`,
    `Deep markets on ${analyzedEvents} matches → ${pool.length} outcomes scored.`,
    run.formHits > 0
      ? `Form/H2H on ${run.formHits}/${run.analyzedCount} matches.`
      : "No form data matched this board.",
    run.includeBasketball ? "Basketball included when available." : "Football only.",
  ]
    .filter(Boolean)
    .join(" ")

  const totalOdds = combinedOdds(picks)
  const combinedConf = combinedConfidence(picks)

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
      const created = await createShareCode(selections, {
        country: run.country,
        bookmaker: run.bookmaker as Bookmaker,
      })
      shareCode = created.shareCode
      shareUrl = created.shareURL
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Could not create booking code"
      warnings.push(`Ticket saved but booking code failed: ${msg}`)
    }
  }

  if (warnings.length) {
    modelNotes = `${warnings.join(" ")} | ${modelNotes}`
  }

  const slip = await db.betSlip.create({
    data: {
      status: shareCode ? "CODED" : "DRAFT",
      label: input.label ?? `Play Rojo · ${picks.length} games`,
      totalOdds,
      combinedConf,
      shareCode,
      shareUrl,
      bookmaker: run.bookmaker,
      country: run.country,
      forecastRunId: run.id,
      notes: modelNotes,
      picks: {
        create: picks.map((p) => ({
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

  await db.forecastRun.update({
    where: { id: runId },
    data: {
      status: RunStatus.DONE,
      legCount: picks.length,
      targetOdds: targetOdds ?? null,
      modelNotes,
      warnings,
    },
  })

  return {
    slip,
    runId: run.id,
    candidateCount: pool.length,
    eventCount: analyzedEvents,
    formHits: run.formHits,
    dateFrom: run.dateFrom ?? "",
    dateTo: run.dateTo ?? "",
    minConfidence: run.minConfidence,
    requestedLegs,
    deliveredLegs: picks.length,
    bestEffort,
    warnings,
  }
}
