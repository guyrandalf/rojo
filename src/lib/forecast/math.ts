/** Small pure helpers for odds math and Poisson scoring. */

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

/** Convert decimal odds to raw implied probability. */
export function rawImplied(odds: number): number {
  if (!Number.isFinite(odds) || odds <= 1) return 0
  return 1 / odds
}

/**
 * Remove bookmaker overround (vig) so outcome probs sum to 1.
 * Multiplicative de-vig is stable for 2-3 way markets.
 */
export function devig(probs: number[]): number[] {
  const cleaned = probs.map((p) => (p > 0 && Number.isFinite(p) ? p : 0))
  const sum = cleaned.reduce((a, b) => a + b, 0)
  if (sum <= 0) return cleaned.map(() => 0)
  return cleaned.map((p) => p / sum)
}

/** Poisson PMF P(K=k | λ). */
export function poissonPmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0
  if (k < 0) return 0
  let logP = -lambda + k * Math.log(lambda)
  for (let i = 2; i <= k; i++) logP -= Math.log(i)
  return Math.exp(logP)
}

/** P(X > line) for Poisson with continuity: over N.5 uses P(X >= N+1). */
export function poissonOver(line: number, lambda: number, maxGoals = 12): number {
  // line like 2.5 → need P(goals >= 3)
  const threshold = Math.floor(line) + 1
  let p = 0
  for (let k = threshold; k <= maxGoals; k++) p += poissonPmf(k, lambda)
  return clamp(p, 0, 1)
}

export function poissonUnder(line: number, lambda: number, maxGoals = 12): number {
  return clamp(1 - poissonOver(line, lambda, maxGoals), 0, 1)
}

/**
 * Independent Poisson 1X2 probabilities from λ_home, λ_away.
 * Slight Dixon-Coles style draw inflation via rho on low-score ties.
 */
export function poisson1x2(
  lambdaHome: number,
  lambdaAway: number,
  maxGoals = 10,
  drawInflation = 0.08
): { home: number; draw: number; away: number } {
  let home = 0
  let draw = 0
  let away = 0

  for (let i = 0; i <= maxGoals; i++) {
    const ph = poissonPmf(i, lambdaHome)
    for (let j = 0; j <= maxGoals; j++) {
      let p = ph * poissonPmf(j, lambdaAway)
      // Mild low-score draw boost (0-0, 1-1)
      if (i === j && i <= 1) p *= 1 + drawInflation
      if (i > j) home += p
      else if (i === j) draw += p
      else away += p
    }
  }

  const [h, d, a] = devig([home, draw, away])
  return { home: h, draw: d, away: a }
}

/** P(both teams score) under independent Poisson. */
export function poissonBttsYes(lambdaHome: number, lambdaAway: number): number {
  const pHome0 = poissonPmf(0, lambdaHome)
  const pAway0 = poissonPmf(0, lambdaAway)
  // 1 - P(home 0) - P(away 0) + P(both 0)
  return clamp(1 - pHome0 - pAway0 + pHome0 * pAway0, 0, 1)
}

/**
 * Infer expected total goals from a totals line and fair P(over).
 * Binary search λ_total such that P(over line | Poisson) ≈ pOver.
 */
export function lambdaFromOverLine(line: number, pOver: number): number {
  const target = clamp(pOver, 0.05, 0.95)
  let lo = 0.2
  let hi = 6.5
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2
    const p = poissonOver(line, mid)
    if (p > target) hi = mid
    else lo = mid
  }
  return (lo + hi) / 2
}

/**
 * Split total goals into home/away lambdas using de-vigged 1X2 strength.
 * Home advantage prior when 1X2 is thin.
 */
export function splitLambdas(
  totalLambda: number,
  fairHome: number,
  fairAway: number,
  homeAdvantage = 1.12
): { lambdaHome: number; lambdaAway: number } {
  const strengthHome = Math.max(0.05, fairHome) * homeAdvantage
  const strengthAway = Math.max(0.05, fairAway)
  const sum = strengthHome + strengthAway
  const shareHome = strengthHome / sum
  // Soften extreme splits so we don't explode on heavy favorites.
  const blendedHome = clamp(0.35 + 0.3 * shareHome, 0.35, 0.68)
  const lambdaHome = totalLambda * blendedHome
  const lambdaAway = Math.max(0.15, totalLambda - lambdaHome)
  return { lambdaHome, lambdaAway }
}

/**
 * If we only have 1X2 (no totals), invent a plausible total from draw rate
 * and favorite strength. Draws correlate with lower scoring.
 */
export function totalFrom1x2(fairHome: number, fairDraw: number, fairAway: number): number {
  const favorite = Math.max(fairHome, fairAway)
  // Base ~2.55 goals; more draws → lower; heavy favorite → slightly higher open games on average mid-table
  let mu = 2.55 - 0.9 * (fairDraw - 0.25) + 0.25 * (favorite - 0.4)
  return clamp(mu, 1.6, 3.6)
}
