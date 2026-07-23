/** Client-side matchday stats (local only). */

const KEY = "rojo.game.v1"

export type GameStats = {
  xp: number
  slipsLocked: number
  bestCombo: number
  lastCode: string | null
  streak: number
  lastDay: string | null
}

const empty: GameStats = {
  xp: 0,
  slipsLocked: 0,
  bestCombo: 0,
  lastCode: null,
  streak: 0,
  lastDay: null,
}

function todayKey() {
  return new Date().toISOString().slice(0, 10)
}

export function loadGameStats(): GameStats {
  if (typeof window === "undefined") return empty
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...empty }
    return { ...empty, ...JSON.parse(raw) }
  } catch {
    return { ...empty }
  }
}

export function saveGameStats(stats: GameStats) {
  if (typeof window === "undefined") return
  localStorage.setItem(KEY, JSON.stringify(stats))
}

/** Call after a successful lock-in. */
export function recordLockIn(opts: {
  legs: number
  totalOdds: number
  code: string | null
}): GameStats {
  const prev = loadGameStats()
  const day = todayKey()
  const streak =
    prev.lastDay === day
      ? prev.streak
      : prev.lastDay ===
          new Date(Date.now() - 86400000).toISOString().slice(0, 10)
        ? prev.streak + 1
        : 1

  const gained = 50 + opts.legs * 15 + Math.min(80, Math.floor(opts.totalOdds * 4))
  const next: GameStats = {
    xp: prev.xp + gained,
    slipsLocked: prev.slipsLocked + 1,
    bestCombo: Math.max(prev.bestCombo, opts.totalOdds),
    lastCode: opts.code ?? prev.lastCode,
    streak,
    lastDay: day,
  }
  saveGameStats(next)
  return next
}

export function levelFromXp(xp: number): { level: number; into: number; need: number } {
  // Clunky linear levels: every 200 XP
  const level = Math.floor(xp / 200) + 1
  const into = xp % 200
  return { level, into, need: 200 }
}
