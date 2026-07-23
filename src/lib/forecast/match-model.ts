import type { SportyEvent, SportyMarket } from "@/lib/sporty/types"
import {
  clamp,
  devig,
  lambdaFromOverLine,
  poisson1x2,
  poissonBttsYes,
  poissonOver,
  poissonUnder,
  rawImplied,
  splitLambdas,
  totalFrom1x2,
} from "./math"

export type MatchModel = {
  eventId: string
  lambdaHome: number
  lambdaAway: number
  totalLambda: number
  fair1x2: { home: number; draw: number; away: number }
  model1x2: { home: number; draw: number; away: number }
  /** model P(over line) keyed by line string e.g. "2.5" */
  modelOver: Record<string, number>
  modelBttsYes: number
  /** Sources used to fit the model */
  usedTotalsLine: number | null
  quality: number // 0-1 how much market data we had
}

function find1x2(markets: SportyMarket[]): SportyMarket | undefined {
  return markets.find(
    (m) =>
      m.status === 0 &&
      (m.id === "1" ||
        m.desc === "1X2" ||
        m.name === "1X2" ||
        m.desc.toLowerCase().includes("1x2"))
  )
}

function parseOuLine(market: SportyMarket): number | null {
  // Specifier often "total=2.5"; desc may include the line.
  const spec = market.specifier ?? ""
  const fromSpec = spec.match(/total[=:]?\s*([0-9]+(?:\.[0-9]+)?)/i)
  if (fromSpec) return Number(fromSpec[1])

  const fromDesc = market.desc.match(/([0-9]+(?:\.[0-9]+)?)/)
  if (fromDesc) return Number(fromDesc[1])

  // Outcomes sometimes labeled "Over 2.5"
  for (const o of market.outcomes ?? []) {
    const m = o.desc.match(/([0-9]+(?:\.[0-9]+)?)/)
    if (m) return Number(m[1])
  }
  return null
}

function isOverUnder(market: SportyMarket): boolean {
  if (market.status !== 0) return false
  if (market.id === "18") return true
  const d = market.desc.toLowerCase()
  return (
    d.includes("over/under") ||
    d.includes("over under") ||
    d.includes("total goals") ||
    d.startsWith("o/u") ||
    Boolean(market.specifier?.includes("total="))
  )
}

function outcomeProb(o: { odds: string; probability?: string }): number {
  if (o.probability) {
    const p = Number(o.probability)
    if (Number.isFinite(p) && p > 0 && p < 1) return p
  }
  return rawImplied(Number(o.odds))
}

/**
 * Build a match-level Poisson model from SportyBet markets on one event.
 * Prefers de-vigged 1X2 + main totals line to fit λ_home / λ_away.
 */
export function buildMatchModel(event: SportyEvent): MatchModel | null {
  const markets = event.markets ?? []
  const m1x2 = find1x2(markets)
  if (!m1x2?.outcomes?.length) return null

  const homeO = m1x2.outcomes.find((o) => o.id === "1" || /home|1\b/i.test(o.desc))
  const drawO = m1x2.outcomes.find((o) => o.id === "2" || /draw|x\b/i.test(o.desc))
  const awayO = m1x2.outcomes.find((o) => o.id === "3" || /away|2\b/i.test(o.desc))
  if (!homeO || !drawO || !awayO) return null

  const [fairHome, fairDraw, fairAway] = devig([
    outcomeProb(homeO),
    outcomeProb(drawO),
    outcomeProb(awayO),
  ])

  // Collect O/U markets with a parseable line; prefer 2.5, then nearest main lines.
  const ouMarkets = markets
    .filter(isOverUnder)
    .map((m) => {
      const line = parseOuLine(m)
      const over = m.outcomes.find((o) => /over/i.test(o.desc))
      const under = m.outcomes.find((o) => /under/i.test(o.desc))
      if (line == null || !over || !under) return null
      const [pOver] = devig([outcomeProb(over), outcomeProb(under)])
      return { line, pOver, market: m }
    })
    .filter(Boolean) as Array<{ line: number; pOver: number; market: SportyMarket }>

  ouMarkets.sort((a, b) => {
    const pref = (l: number) => Math.abs(l - 2.5)
    return pref(a.line) - pref(b.line)
  })

  let totalLambda: number
  let usedTotalsLine: number | null = null
  let quality = 0.55

  if (ouMarkets[0]) {
    usedTotalsLine = ouMarkets[0].line
    totalLambda = lambdaFromOverLine(ouMarkets[0].line, ouMarkets[0].pOver)
    quality = 0.85
    // If second line exists, average lambdas for stability.
    if (ouMarkets[1]) {
      const l2 = lambdaFromOverLine(ouMarkets[1].line, ouMarkets[1].pOver)
      totalLambda = (totalLambda + l2) / 2
      quality = 0.95
    }
  } else {
    totalLambda = totalFrom1x2(fairHome, fairDraw, fairAway)
  }

  const { lambdaHome, lambdaAway } = splitLambdas(totalLambda, fairHome, fairAway)
  const model1x2 = poisson1x2(lambdaHome, lambdaAway)
  const modelBttsYes = poissonBttsYes(lambdaHome, lambdaAway)

  const modelOver: Record<string, number> = {}
  for (const ou of ouMarkets) {
    modelOver[String(ou.line)] = poissonOver(ou.line, lambdaHome + lambdaAway)
  }
  // Always expose 2.5 for consumers even if not on the board.
  if (!modelOver["2.5"]) {
    modelOver["2.5"] = poissonOver(2.5, lambdaHome + lambdaAway)
  }

  return {
    eventId: event.eventId,
    lambdaHome,
    lambdaAway,
    totalLambda: lambdaHome + lambdaAway,
    fair1x2: { home: fairHome, draw: fairDraw, away: fairAway },
    model1x2,
    modelOver,
    modelBttsYes,
    usedTotalsLine,
    quality,
  }
}

export type FormSnapshot = {
  teamKey: string
  teamName: string
  played: number
  wins: number
  draws: number
  losses: number
  goalsFor: number
  goalsAgainst: number
  /** 0-1 form score from last N */
  formScore: number
  recent: string // e.g. "WWDLL"
}

export type H2HSnapshot = {
  meetings: number
  homeTeamWins: number
  awayTeamWins: number
  draws: number
  avgGoals: number
}

export type EnrichedMatchContext = {
  model: MatchModel
  homeForm?: FormSnapshot
  awayForm?: FormSnapshot
  h2h?: H2HSnapshot
  /** Adjusted lambdas after form */
  lambdaHomeAdj: number
  lambdaAwayAdj: number
}

/**
 * Apply form/H2H as multiplicative adjustments on lambdas, then recompute markets.
 */
export function applyFormToModel(
  model: MatchModel,
  homeForm?: FormSnapshot,
  awayForm?: FormSnapshot,
  h2h?: H2HSnapshot
): EnrichedMatchContext {
  let lh = model.lambdaHome
  let la = model.lambdaAway

  if (homeForm && homeForm.played >= 3) {
    // formScore 0.5 neutral; above → more goals for, fewer against
    const attack = 0.85 + 0.3 * homeForm.formScore
    const defense = 1.15 - 0.3 * homeForm.formScore
    lh *= attack
    la *= defense
  }
  if (awayForm && awayForm.played >= 3) {
    const attack = 0.85 + 0.3 * awayForm.formScore
    const defense = 1.15 - 0.3 * awayForm.formScore
    la *= attack
    lh *= defense
  }

  if (h2h && h2h.meetings >= 3) {
    // Pull total goals slightly toward historical H2H average.
    const hist = clamp(h2h.avgGoals, 1.4, 4.0)
    const cur = lh + la
    const blended = 0.7 * cur + 0.3 * hist
    const scale = blended / Math.max(0.2, cur)
    lh *= scale
    la *= scale
  }

  lh = clamp(lh, 0.2, 3.8)
  la = clamp(la, 0.2, 3.8)

  const model1x2 = poisson1x2(lh, la)
  const modelBttsYes = poissonBttsYes(lh, la)
  const modelOver: Record<string, number> = {}
  for (const line of Object.keys(model.modelOver)) {
    modelOver[line] = poissonOver(Number(line), lh + la)
  }

  return {
    model: {
      ...model,
      lambdaHome: lh,
      lambdaAway: la,
      totalLambda: lh + la,
      model1x2,
      modelOver,
      modelBttsYes,
      quality: Math.min(1, model.quality + (homeForm || awayForm ? 0.05 : 0)),
    },
    homeForm,
    awayForm,
    h2h,
    lambdaHomeAdj: lh,
    lambdaAwayAdj: la,
  }
}

export function modelProbForOutcome(
  ctx: EnrichedMatchContext,
  marketId: string,
  marketDesc: string,
  outcomeDesc: string,
  specifier: string | null
): { modelProb: number; label: string } | null {
  const m = ctx.model
  const kindDesc = marketDesc.toLowerCase()
  const out = outcomeDesc.toLowerCase()

  // 1X2
  if (marketId === "1" || kindDesc.includes("1x2") || kindDesc === "match result") {
    if (out.includes("home") || out === "1" || out === "home") {
      return { modelProb: m.model1x2.home, label: "model Home" }
    }
    if (out.includes("draw") || out === "x") {
      return { modelProb: m.model1x2.draw, label: "model Draw" }
    }
    if (out.includes("away") || out === "2" || out === "away") {
      return { modelProb: m.model1x2.away, label: "model Away" }
    }
  }

  // Over/Under
  if (
    marketId === "18" ||
    kindDesc.includes("over/under") ||
    kindDesc.includes("total") ||
    (specifier && specifier.includes("total="))
  ) {
    let line =
      (specifier?.match(/total[=:]?\s*([0-9.]+)/i)?.[1] &&
        Number(specifier.match(/total[=:]?\s*([0-9.]+)/i)![1])) ||
      Number(outcomeDesc.match(/([0-9]+(?:\.[0-9]+)?)/)?.[1] ?? NaN)

    if (!Number.isFinite(line)) line = 2.5
    const key = String(line)
    const pOver = m.modelOver[key] ?? poissonOver(line, m.totalLambda)
    if (out.includes("over") || out.startsWith("o ")) {
      return { modelProb: pOver, label: `model Over ${line}` }
    }
    if (out.includes("under") || out.startsWith("u ")) {
      return {
        modelProb: poissonUnder(line, m.totalLambda),
        label: `model Under ${line}`,
      }
    }
  }

  // BTTS / GG-NG
  if (
    marketId === "29" ||
    kindDesc.includes("both teams") ||
    kindDesc.includes("btts") ||
    kindDesc.includes("gg/ng") ||
    kindDesc.includes("gg")
  ) {
    if (out.includes("yes") || out === "gg" || out.includes("goal")) {
      return { modelProb: m.modelBttsYes, label: "model BTTS Yes" }
    }
    if (out.includes("no") || out === "ng") {
      return { modelProb: 1 - m.modelBttsYes, label: "model BTTS No" }
    }
  }

  return null
}
