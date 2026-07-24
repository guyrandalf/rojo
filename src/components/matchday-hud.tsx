"use client"

import { useEffect, useState } from "react"
import { levelFromXp, loadGameStats, type GameStats } from "@/lib/game-stats"

export function MatchdayHud({ bump }: { bump?: number }) {
  const [stats, setStats] = useState<GameStats | null>(null)

  useEffect(() => {
    setStats(loadGameStats())
  }, [bump])

  if (!stats) {
    return (
      <div className="plate px-4 py-3 text-base font-semibold text-mute">
        Loading…
      </div>
    )
  }

  const { level, into, need } = levelFromXp(stats.xp)
  const pct = Math.min(100, Math.round((into / need) * 100))

  return (
    <div className="plate grid grid-cols-2 gap-4 p-4 sm:grid-cols-4 sm:p-5">
      <div>
        <p className="hud-label">Your level</p>
        <p className="stamp text-3xl text-gold sm:text-4xl">LV {level}</p>
      </div>
      <div>
        <p className="hud-label">Points</p>
        <p className="font-mono text-2xl font-bold text-ink">{stats.xp}</p>
        <div className="meter mt-2">
          <span style={{ width: `${pct}%` }} />
        </div>
      </div>
      <div>
        <p className="hud-label">Codes you made</p>
        <p className="font-mono text-2xl font-bold">
          {stats.slipsLocked}{" "}
          <span className="text-base font-semibold text-mute">tickets</span>
        </p>
      </div>
      <div>
        <p className="hud-label">Days in a row · Best total odds</p>
        <p className="font-mono text-2xl font-bold">
          {stats.streak}d ·{" "}
          <span className="text-gold">
            {stats.bestCombo ? stats.bestCombo.toFixed(2) : "—"}
          </span>
        </p>
      </div>
    </div>
  )
}
