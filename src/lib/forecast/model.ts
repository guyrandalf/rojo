import type { CandidatePick, SportyEvent } from "@/lib/sporty/types"
import { flattenActiveOutcomes } from "@/lib/sporty/client"
import {
  applyFormToModel,
  buildMatchModel,
  modelProbForOutcome,
  type EnrichedMatchContext,
  type FormSnapshot,
  type H2HSnapshot,
} from "./match-model"
import { clamp } from "./math"

export type ForecastOptions = {
  legCount?: number
  minOdds?: number
  maxOdds?: number
  markets?: Array<"match_result" | "over_under" | "btts" | "any">
  maxHoursAhead?: number
  /**
   * Inclusive local calendar dates `YYYY-MM-DD`.
   * When set, kickoffs outside [from 00:00, to 23:59:59] are dropped.
   */
  dateFrom?: string
  dateTo?: string
  /**
   * Minimum chance we want the pick to "happen" (0-1).
   * Filters on max(bookImplied, model confidence). Default ~0.68 (~70% mode).
   */
  minConfidence?: number
  /**
   * When true (default for high-prob desks), rank by confidence first,
   * not by positive model edge.
   */
  preferHighProbability?: boolean
}

/** Start/end of a local calendar day as epoch ms. */
export function localDayBounds(dateYmd: string): { start: number; end: number } {
  const [y, m, d] = dateYmd.split("-").map(Number)
  const start = new Date(y, m - 1, d, 0, 0, 0, 0).getTime()
  const end = new Date(y, m - 1, d, 23, 59, 59, 999).getTime()
  return { start, end }
}

export function todayYmd(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

export function addDaysYmd(dateYmd: string, days: number): string {
  const [y, m, d] = dateYmd.split("-").map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + days)
  return todayYmd(dt)
}

function marketKind(
  marketId: string,
  desc: string
): "match_result" | "over_under" | "btts" | "other" {
  const d = desc.toLowerCase()
  if (marketId === "1" || d.includes("1x2") || d === "match result") {
    return "match_result"
  }
  if (
    marketId === "18" ||
    d.includes("over/under") ||
    d.includes("total goals") ||
    d.startsWith("o/u")
  ) {
    return "over_under"
  }
  if (
    marketId === "29" ||
    d.includes("both teams") ||
    d.includes("btts") ||
    d.includes("gg/ng")
  ) {
    return "btts"
  }
  return "other"
}

/**
 * Blend book fair probability with Poisson model probability.
 * Prefer model when market data quality is high; still respect the book.
 *
 * Confidence is multi-leg oriented: high modelProb, non-negative edge preferred.
 * Edge ≈ modelProb - bookImplied (positive = model likes it more than the price).
 */
export function scoreOutcome(input: {
  odds: number
  feedProbability?: number
  marketId: string
  marketDesc: string
  outcomeDesc: string
  specifier: string | null
  hoursUntilKickoff: number
  ctx?: EnrichedMatchContext | null
}): { confidence: number; edge: number; reasoning: string } {
  const bookImplied =
    input.feedProbability &&
    input.feedProbability > 0 &&
    input.feedProbability < 1
      ? input.feedProbability
      : 1 / input.odds

  const notes: string[] = []
  notes.push(`Book ~${(bookImplied * 100).toFixed(0)}% @ ${input.odds.toFixed(2)}`)

  let modelProb = bookImplied
  let modelWeight = 0.15

  if (input.ctx) {
    const mp = modelProbForOutcome(
      input.ctx,
      input.marketId,
      input.marketDesc,
      input.outcomeDesc,
      input.specifier
    )
    if (mp) {
      modelProb = mp.modelProb
      modelWeight = clamp(0.35 + 0.45 * input.ctx.model.quality, 0.35, 0.8)
      notes.push(
        `${mp.label} ${(modelProb * 100).toFixed(0)}% (λ ${input.ctx.model.lambdaHome.toFixed(2)}-${input.ctx.model.lambdaAway.toFixed(2)})`
      )
    }

    const hf = input.ctx.homeForm
    const af = input.ctx.awayForm
    if (hf && hf.played >= 3) {
      notes.push(`Home form ${hf.recent} (${hf.wins}W${hf.draws}D${hf.losses}L)`)
    }
    if (af && af.played >= 3) {
      notes.push(`Away form ${af.recent} (${af.wins}W${af.draws}D${af.losses}L)`)
    }
    if (input.ctx.h2h && input.ctx.h2h.meetings >= 2) {
      const h = input.ctx.h2h
      notes.push(
        `H2H ${h.meetings}g: ${h.homeTeamWins}-${h.draws}-${h.awayTeamWins}, ${h.avgGoals.toFixed(1)} g/g`
      )
    }
  } else {
    notes.push("Poisson fit unavailable; book-only baseline")
  }

  // Bayesian-ish blend
  let confidence =
    (1 - modelWeight) * bookImplied + modelWeight * modelProb

  const edge = modelProb - bookImplied
  if (edge >= 0.03) {
    confidence += Math.min(0.06, edge * 0.5)
    notes.push(`+edge ${(edge * 100).toFixed(1)}pp vs book`)
  } else if (edge <= -0.05) {
    confidence -= Math.min(0.08, Math.abs(edge) * 0.6)
    notes.push(`model colder than book (${(edge * 100).toFixed(1)}pp)`)
  }

  // Multi-leg hygiene: longshots and ultra-shorts
  if (input.odds > 2.6) {
    confidence -= 0.06
    notes.push("longshot penalty for multi")
  } else if (input.odds < 1.2) {
    confidence -= 0.025
    notes.push("short price; little multi juice")
  } else if (input.odds >= 1.35 && input.odds <= 1.9 && modelProb >= 0.52) {
    confidence += 0.02
    notes.push("solid multi band")
  }

  // Timing
  if (input.hoursUntilKickoff <= 12) {
    confidence += 0.01
  } else if (input.hoursUntilKickoff > 48) {
    confidence -= 0.015
    notes.push("kickoff >48h")
  }

  // Require non-trivial model support for very high conf
  confidence = clamp(confidence, 0.05, 0.92)

  return {
    confidence,
    edge,
    reasoning: notes.join(". ") + ".",
  }
}

export type FormBundle = {
  homeForm?: FormSnapshot
  awayForm?: FormSnapshot
  h2h?: H2HSnapshot
}

export function buildCandidates(
  events: SportyEvent[],
  options: ForecastOptions = {},
  formByEvent?: Map<string, FormBundle>
): CandidatePick[] {
  const minOdds = options.minOdds ?? 1.12
  // High-probability desk: keep prices short enough to map near minConfidence
  const minConfidence = options.minConfidence ?? 0.6
  // Lenient cap: allow user maxOdds more room past pure 1/minConf
  const autoMaxFromConf = 1 / Math.max(0.45, minConfidence - 0.1)
  const maxOdds = options.maxOdds ?? Math.min(2.1, autoMaxFromConf * 1.15)
  const maxHours = options.maxHoursAhead ?? 240
  const allowed = new Set(
    options.markets ?? ["match_result", "over_under", "btts"]
  )
  const now = Date.now()

  let windowStart = now + 15 * 60 * 1000 // skip started / imminent
  let windowEnd = now + maxHours * 60 * 60 * 1000
  if (options.dateFrom) {
    windowStart = Math.max(windowStart, localDayBounds(options.dateFrom).start)
  }
  if (options.dateTo) {
    windowEnd = Math.min(windowEnd, localDayBounds(options.dateTo).end)
  }

  const candidates: CandidatePick[] = []

  // Pre-build match models once per event
  const ctxByEvent = new Map<string, EnrichedMatchContext | null>()
  for (const event of events) {
    const kickoffMs = event.estimateStartTime
    if (kickoffMs < windowStart || kickoffMs > windowEnd) continue

    const base = buildMatchModel(event)
    if (!base) {
      ctxByEvent.set(event.eventId, null)
      continue
    }
    const forms = formByEvent?.get(event.eventId)
    ctxByEvent.set(
      event.eventId,
      applyFormToModel(base, forms?.homeForm, forms?.awayForm, forms?.h2h)
    )
  }

  for (const event of events) {
    const kickoffMs = event.estimateStartTime
    if (kickoffMs < windowStart || kickoffMs > windowEnd) continue

    const hoursUntil = (kickoffMs - now) / (1000 * 60 * 60)
    const tournament = event.sport?.category?.tournament?.name
    const ctx = ctxByEvent.get(event.eventId) ?? null
    const rows = flattenActiveOutcomes(event)

    for (const { market, outcome } of rows) {
      const kind = marketKind(market.id, market.desc)
      if (!allowed.has("any") && kind !== "other" && !allowed.has(kind)) continue
      if (kind === "other" && !allowed.has("any")) continue

      const odds = Number(outcome.odds)
      if (odds < minOdds || odds > maxOdds) continue

      const feedProb = outcome.probability ? Number(outcome.probability) : undefined
      const scored = scoreOutcome({
        odds,
        feedProbability:
          feedProb && Number.isFinite(feedProb) ? feedProb : undefined,
        marketId: market.id,
        marketDesc: market.desc,
        outcomeDesc: outcome.desc,
        specifier: market.specifier ?? null,
        hoursUntilKickoff: hoursUntil,
        ctx,
      })

      const impliedProb =
        feedProb && Number.isFinite(feedProb) && feedProb > 0
          ? feedProb
          : 1 / odds

      // "Likely to happen" gate: book or model must clear the bar
      const chance = Math.max(impliedProb, scored.confidence)
      if (chance < minConfidence) continue

      const sourceOdds: Record<string, number> = {}
      for (const o of market.outcomes) {
        sourceOdds[o.desc] = Number(o.odds)
      }

      // In high-prob mode, surface "chance" as confidence so the desk
      // shows ~70%+ rather than a colder model-only number.
      const displayConf =
        options.preferHighProbability !== false
          ? chance
          : scored.confidence

      candidates.push({
        eventId: event.eventId,
        gameId: event.gameId,
        homeTeam: event.homeTeamName,
        awayTeam: event.awayTeamName,
        tournament,
        kickoffAt: new Date(kickoffMs),
        marketId: market.id,
        marketDesc: market.desc,
        outcomeId: outcome.id,
        outcomeDesc: outcome.desc,
        specifier: market.specifier ?? null,
        odds,
        impliedProb,
        confidence: displayConf,
        edge: scored.edge,
        reasoning: scored.reasoning,
        sourceOdds,
      })
    }
  }

  return candidates
}

function pickMarketBucket(p: CandidatePick): string {
  return marketKind(p.marketId, p.marketDesc)
}

/**
 * Select legs by confidence, with soft market diversity.
 * High-probability mode ranks pure chance first (what the user means by ~70%).
 */
export function selectLegs(
  candidates: CandidatePick[],
  legCount: number,
  options?: { preferHighProbability?: boolean }
): CandidatePick[] {
  const highProb = options?.preferHighProbability !== false

  const sorted = [...candidates].sort((a, b) => {
    const aChance = Math.max(a.impliedProb, a.confidence)
    const bChance = Math.max(b.impliedProb, b.confidence)
    if (highProb) {
      if (bChance !== aChance) return bChance - aChance
      if (b.confidence !== a.confidence) return b.confidence - a.confidence
      // Prefer slightly better price among similar probs
      return a.odds - b.odds
    }
    const aEdgeOk = a.edge >= -0.02 ? 1 : 0
    const bEdgeOk = b.edge >= -0.02 ? 1 : 0
    if (bEdgeOk !== aEdgeOk) return bEdgeOk - aEdgeOk
    if (b.confidence !== a.confidence) return b.confidence - a.confidence
    return b.edge - a.edge
  })

  const selected: CandidatePick[] = []
  const usedEvents = new Set<string>()
  const bucketCounts = new Map<string, number>()
  const maxPerBucket = Math.max(2, Math.ceil(legCount * 0.5))

  for (const c of sorted) {
    if (selected.length >= legCount) break
    if (usedEvents.has(c.eventId)) continue

    const bucket = pickMarketBucket(c)
    const count = bucketCounts.get(bucket) ?? 0
    if (count >= maxPerBucket) {
      const remainingSlots = legCount - selected.length
      const remainingCandidates = sorted.filter(
        (x) =>
          !usedEvents.has(x.eventId) &&
          (bucketCounts.get(pickMarketBucket(x)) ?? 0) < maxPerBucket
      )
      if (remainingCandidates.length >= remainingSlots) continue
    }

    usedEvents.add(c.eventId)
    bucketCounts.set(bucket, count + 1)
    selected.push(c)
  }

  if (selected.length < legCount) {
    for (const c of sorted) {
      if (selected.length >= legCount) break
      if (usedEvents.has(c.eventId)) continue
      usedEvents.add(c.eventId)
      selected.push(c)
    }
  }

  return selected
}

export function combinedOdds(picks: CandidatePick[]): number {
  return picks.reduce((acc, p) => acc * p.odds, 1)
}

export function combinedConfidence(picks: CandidatePick[]): number {
  return picks.reduce((acc, p) => acc * p.confidence, 1)
}
