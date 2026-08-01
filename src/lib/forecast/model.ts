import type { CandidatePick, SportyEvent } from "@/lib/sporty/types"
import { flattenActiveOutcomes } from "@/lib/sporty/client"
import {
  applyFormToModel,
  buildMatchModel,
  modelProbForOutcome,
  type EnrichedMatchContext,
  type FormBundle,
} from "./match-model"
import { clamp } from "./math"

export type { FormBundle }

export type ForecastOptions = {
  legCount?: number
  /** Optional soft odds band — usually unused; ranking is % based */
  minOdds?: number
  maxOdds?: number
  markets?: Array<"match_result" | "over_under" | "btts" | "any">
  maxHoursAhead?: number
  dateFrom?: string
  dateTo?: string
  /**
   * Minimum analysis conviction (0-1). Not the same as short odds.
   * A 4.00 can score high if model/form backs it; 1.05 can score low if model disagrees.
   */
  minConfidence?: number
  preferHighProbability?: boolean
}

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
  if (
    marketId === "1" ||
    marketId === "219" ||
    d.includes("1x2") ||
    d === "match result" ||
    d.includes("winner")
  ) {
    return "match_result"
  }
  if (
    marketId === "18" ||
    d.includes("over/under") ||
    d.includes("total goals") ||
    d.includes("total points") ||
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

/** True for markets we will at least attempt (not pure micro-minute junk spam). */
function isAnalyzableMarket(marketId: string, desc: string): boolean {
  const d = desc.toLowerCase()
  // Drop ultra-noisy minute-band props unless we have strong feed probs
  if (/from 1 to \d+ minute/i.test(d) && !d.includes("half")) return false
  if (d.includes("odd or even") && !d.includes("total")) return false

  // Keep main + deep but common
  if (
    marketKind(marketId, desc) !== "other" ||
    d.includes("double chance") ||
    d.includes("draw no bet") ||
    d.includes("half") ||
    d.includes("corner") ||
    d.includes("handicap") ||
    d.includes("win to nil") ||
    d.includes("team total") ||
    d.includes("home team") ||
    d.includes("away team") ||
    d.includes("exact") ||
    d.includes("clean sheet") ||
    d.includes("goal") ||
    d.includes("winner")
  ) {
    return true
  }
  return false
}

/**
 * Analysis-first scoring. Odds are a quote, not the truth.
 * - Model (Poisson/form) when available
 * - Book feed probability as market view
 * - Trap shorts (model much colder than book) get downgraded even at 1.05
 * - Value longshots (model hotter than book) can score well even at 4.00
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
  notes.push(
    `Market price ${input.odds.toFixed(2)} (implies ~${(bookImplied * 100).toFixed(0)}%)`
  )

  let modelProb = bookImplied
  let modelWeight = 0.12
  let hasModel = false

  if (input.ctx) {
    const mp = modelProbForOutcome(
      input.ctx,
      input.marketId,
      input.marketDesc,
      input.outcomeDesc,
      input.specifier
    )
    if (mp) {
      hasModel = true
      modelProb = mp.modelProb
      modelWeight = clamp(0.4 + 0.4 * input.ctx.model.quality, 0.4, 0.85)
      notes.push(
        `Model ${mp.label} ${(modelProb * 100).toFixed(0)}% (λ ${input.ctx.model.lambdaHome.toFixed(2)}-${input.ctx.model.lambdaAway.toFixed(2)})`
      )
    } else {
      notes.push("Deep/special market: conviction from price + form context")
      modelWeight = 0.08
    }

    const hf = input.ctx.homeForm
    const af = input.ctx.awayForm
    if (hf && hf.played >= 3) {
      notes.push(`Home form ${hf.recent}`)
      if (hf.formScore >= 0.65) modelProb = clamp(modelProb + 0.02, 0.05, 0.95)
      if (hf.formScore <= 0.35) modelProb = clamp(modelProb - 0.02, 0.05, 0.95)
    }
    if (af && af.played >= 3) {
      notes.push(`Away form ${af.recent}`)
    }
    if (input.ctx.h2h && input.ctx.h2h.meetings >= 2) {
      const h = input.ctx.h2h
      notes.push(
        `H2H ${h.meetings}g ${h.homeTeamWins}-${h.draws}-${h.awayTeamWins}`
      )
    }
  } else {
    notes.push("No match model; using market probability + structure only")
  }

  let confidence = (1 - modelWeight) * bookImplied + modelWeight * modelProb
  const edge = modelProb - bookImplied

  if (hasModel && edge >= 0.04) {
    confidence += Math.min(0.08, edge * 0.55)
    notes.push(
      `Analysis likes this more than the price (+${(edge * 100).toFixed(1)}pp) — not just short odds`
    )
  } else if (hasModel && edge <= -0.06) {
    // Classic trap: 1.05 that the model hates
    confidence -= Math.min(0.12, Math.abs(edge) * 0.7)
    notes.push(
      `Trap risk: price is shorter than analysis (${(edge * 100).toFixed(1)}pp) — 1.05 can still fail`
    )
  }

  // Deep markets without model: require solid feed signal, slight haircut
  if (!hasModel && marketKind(input.marketId, input.marketDesc) === "other") {
    confidence *= 0.92
    notes.push("Special market haircut (less model coverage)")
  }

  if (input.hoursUntilKickoff <= 12) {
    confidence += 0.01
  } else if (input.hoursUntilKickoff > 72) {
    confidence -= 0.02
    notes.push("Far kickoff; more uncertainty")
  }

  confidence = clamp(confidence, 0.05, 0.94)
  notes.push(`Conviction score ${(confidence * 100).toFixed(0)}%`)

  return {
    confidence,
    edge,
    reasoning: notes.join(". ") + ".",
  }
}

/** Kickoff window a run will consider, in epoch ms. */
export function forecastWindow(options: ForecastOptions = {}): {
  start: number
  end: number
} {
  const maxHours = options.maxHoursAhead ?? 336
  const now = Date.now()

  let start = now + 15 * 60 * 1000
  let end = now + maxHours * 60 * 60 * 1000
  if (options.dateFrom) {
    start = Math.max(start, localDayBounds(options.dateFrom).start)
  }
  if (options.dateTo) {
    end = Math.min(end, localDayBounds(options.dateTo).end)
  }
  return { start, end }
}

/**
 * Score every analyzable outcome on ONE fixture.
 *
 * Single-match by design: a run analyses one fixture per HTTP request and
 * persists the result, so no single request has to survive the whole board.
 */
export function buildCandidatesForEvent(
  event: SportyEvent,
  options: ForecastOptions = {},
  form?: FormBundle
): CandidatePick[] {
  const minConfidence = options.minConfidence ?? 0.62
  // Odds band optional — default: no limit (analysis-only)
  const minOdds = options.minOdds ?? 1.01
  const maxOdds = options.maxOdds ?? 100
  const allowed = new Set(options.markets ?? ["any"])
  const now = Date.now()
  const { start: windowStart, end: windowEnd } = forecastWindow(options)

  const kickoffMs = event.estimateStartTime
  if (kickoffMs < windowStart || kickoffMs > windowEnd) return []

  const base = buildMatchModel(event)
  const ctx: EnrichedMatchContext | null = base
    ? applyFormToModel(base, form?.homeForm, form?.awayForm, form?.h2h)
    : null

  const hoursUntil = (kickoffMs - now) / (1000 * 60 * 60)
  const tournament = event.sport?.category?.tournament?.name
  const sportName = event.sport?.name
  const candidates: CandidatePick[] = []

  for (const { market, outcome } of flattenActiveOutcomes(event)) {
    if (!isAnalyzableMarket(market.id, market.desc)) continue

    const kind = marketKind(market.id, market.desc)
    if (!allowed.has("any") && kind !== "other" && !allowed.has(kind)) continue

    const odds = Number(outcome.odds)
    if (!Number.isFinite(odds) || odds < minOdds || odds > maxOdds) continue

    const feedProb = outcome.probability ? Number(outcome.probability) : undefined
    // Need either feed probability or a model path for conviction
    const hasFeed =
      feedProb != null && Number.isFinite(feedProb) && feedProb > 0.05
    if (!hasFeed && !ctx) continue

    const scored = scoreOutcome({
      odds,
      feedProbability: hasFeed ? feedProb : undefined,
      marketId: market.id,
      marketDesc: market.desc,
      outcomeDesc: outcome.desc,
      specifier: market.specifier ?? null,
      hoursUntilKickoff: hoursUntil,
      ctx,
    })

    if (scored.confidence < minConfidence) continue

    const impliedProb = hasFeed && feedProb! > 0 ? feedProb! : 1 / odds

    const sourceOdds: Record<string, number> = {}
    for (const o of market.outcomes) {
      sourceOdds[o.desc] = Number(o.odds)
    }

    const labelTournament = sportName
      ? `${tournament ?? "—"} · ${sportName}`
      : tournament

    candidates.push({
      eventId: event.eventId,
      gameId: event.gameId,
      homeTeam: event.homeTeamName,
      awayTeam: event.awayTeamName,
      tournament: labelTournament,
      kickoffAt: new Date(kickoffMs),
      marketId: market.id,
      marketDesc: market.desc,
      outcomeId: outcome.id,
      outcomeDesc: outcome.desc,
      specifier: market.specifier ?? null,
      odds,
      impliedProb,
      confidence: scored.confidence,
      edge: scored.edge,
      reasoning: scored.reasoning,
      sourceOdds,
    })
  }

  return candidates
}

function pickMarketBucket(p: CandidatePick): string {
  return marketKind(p.marketId, p.marketDesc)
}

/**
 * Rank by analysis conviction (confidence), not by short odds.
 */
export function selectLegs(
  candidates: CandidatePick[],
  legCount: number,
  options?: { preferHighProbability?: boolean }
): CandidatePick[] {
  const highProb = options?.preferHighProbability !== false

  const sorted = [...candidates].sort((a, b) => {
    if (highProb) {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence
      // Prefer positive analysis edge over blindly shorter price
      if (b.edge !== a.edge) return b.edge - a.edge
      return a.odds - b.odds
    }
    if (b.edge !== a.edge) return b.edge - a.edge
    return b.confidence - a.confidence
  })

  const selected: CandidatePick[] = []
  const usedEvents = new Set<string>()
  const bucketCounts = new Map<string, number>()
  // Allow more market variety when deep markets are on
  const maxPerBucket = Math.max(3, Math.ceil(legCount * 0.55))

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

/**
 * Build the SAFEST slip whose total odds reach `targetOdds`.
 *
 * The punter states the payout they want ("give me 5 odds"); the desk's job is
 * to spend as little risk as possible getting there. In log space that is:
 * maximize Σ log(confidence) subject to Σ log(odds) ≥ log(target), ≤ maxLegs
 * legs, one pick per match.
 *
 * Greedy in three passes, run once per leg budget k = 2..maxLegs (the pool is
 * ≤ ~40 matches, so this is cheap), keeping the most confident slip that
 * reaches the target. Trying every k matters: a 2-odds target is safer as two
 * 1.45s than as four 1.20s, and only the small-k run finds that.
 *
 * Per run:
 *  1. Baseline: the most confident option per match, safest matches first.
 *  2. Upgrade: while short of the target, apply the move that buys the most
 *     log-odds for the least confidence lost — either switching a chosen match
 *     to a longer-odds option, or adding another match.
 *  3. Trim: drop the least confident legs the target can spare, so we do not
 *     carry risk the payout does not need.
 */
export function selectLegsForTargetOdds(
  candidates: CandidatePick[],
  options: { targetOdds: number; maxLegs: number }
): { picks: CandidatePick[]; reachedTarget: boolean } {
  const maxLegs = Math.max(2, options.maxLegs)
  const logTarget = Math.log(Math.max(1.2, options.targetOdds))

  const byEvent = new Map<string, CandidatePick[]>()
  for (const c of candidates) {
    const list = byEvent.get(c.eventId)
    if (list) list.push(c)
    else byEvent.set(c.eventId, [c])
  }
  for (const list of byEvent.values()) {
    list.sort((a, b) => b.confidence - a.confidence || a.odds - b.odds)
  }

  const events = [...byEvent.entries()]
    .map(([eventId, list]) => ({ eventId, list }))
    .sort((a, b) => b.list[0].confidence - a.list[0].confidence)

  if (events.length === 0) return { picks: [], reachedTarget: false }

  const runWithBudget = (
    legBudget: number
  ): { picks: CandidatePick[]; reached: boolean; logOdds: number } => {
    // 1. Baseline: safest option on the safest matches.
    const chosen = new Map<string, CandidatePick>()
    for (const e of events.slice(0, legBudget)) chosen.set(e.eventId, e.list[0])

    const totalLogOdds = () =>
      [...chosen.values()].reduce((s, p) => s + Math.log(p.odds), 0)

    // 2. Upgrade until the target is met or no move is left. While far from
    // the target, take the move with the best odds-per-risk ratio; once a
    // single move can cross the line, take the CHEAPEST crossing move instead,
    // so the last step does not overshoot into needless risk.
    let guard = 300
    while (totalLogOdds() < logTarget && guard-- > 0) {
      const needed = logTarget - totalLogOdds()
      let bestRatio: { ratio: number; apply: () => void } | null = null
      let bestFinal: { cost: number; apply: () => void } | null = null

      const consider = (gain: number, cost: number, apply: () => void) => {
        if (gain <= 0) return
        const ratio = cost / gain
        if (!bestRatio || ratio < bestRatio.ratio) bestRatio = { ratio, apply }
        if (gain >= needed && (!bestFinal || cost < bestFinal.cost)) {
          bestFinal = { cost, apply }
        }
      }

      // Switch a chosen match to a longer-odds option on the same match.
      for (const [eventId, cur] of chosen) {
        for (const alt of byEvent.get(eventId)!) {
          if (alt.odds <= cur.odds) continue
          consider(
            Math.log(alt.odds) - Math.log(cur.odds),
            Math.log(cur.confidence) - Math.log(alt.confidence),
            () => chosen.set(eventId, alt)
          )
        }
      }

      // Or bring in another match, if there is room.
      if (chosen.size < legBudget) {
        for (const e of events) {
          if (chosen.has(e.eventId)) continue
          const alt = e.list[0]
          consider(Math.log(alt.odds), -Math.log(alt.confidence), () =>
            chosen.set(e.eventId, alt)
          )
        }
      }

      const move = bestFinal ?? bestRatio
      if (!move) break
      ;(move as { apply: () => void }).apply()
    }

    // 3. Trim legs the target does not need, least confident first.
    let trimmed = true
    while (trimmed && chosen.size > 2) {
      trimmed = false
      let drop: string | null = null
      let dropConf = Infinity
      const current = totalLogOdds()
      for (const [eventId, p] of chosen) {
        const without = current - Math.log(p.odds)
        if (without >= logTarget && p.confidence < dropConf) {
          dropConf = p.confidence
          drop = eventId
        }
      }
      if (drop) {
        chosen.delete(drop)
        trimmed = true
      }
    }

    const logOdds = totalLogOdds()
    return {
      picks: [...chosen.values()].sort((a, b) => b.confidence - a.confidence),
      reached: logOdds >= logTarget - 1e-9,
      logOdds,
    }
  }

  let best: { picks: CandidatePick[]; reached: boolean; logOdds: number } | null =
    null
  for (let k = 2; k <= maxLegs; k++) {
    const r = runWithBudget(k)
    if (!best) {
      best = r
      continue
    }
    if (r.reached && !best.reached) {
      best = r
      continue
    }
    if (r.reached === best.reached) {
      if (r.reached) {
        // Both reach the target: take the safer slip.
        const conf = (x: typeof r) =>
          x.picks.reduce((s, p) => s + Math.log(p.confidence), 0)
        if (conf(r) > conf(best)) best = r
      } else if (r.logOdds > best.logOdds) {
        // Neither reaches it: take whichever got closer.
        best = r
      }
    }
  }

  return { picks: best!.picks, reachedTarget: best!.reached }
}

export function combinedOdds(picks: CandidatePick[]): number {
  return picks.reduce((acc, p) => acc * p.odds, 1)
}

export function combinedConfidence(picks: CandidatePick[]): number {
  return picks.reduce((acc, p) => acc * p.confidence, 1)
}
