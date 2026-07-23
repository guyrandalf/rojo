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
      <div className="plate px-3 py-2 font-mono text-xs text-mute">LOADING HUD…</div>
    )
  }

  const { level, into, need } = levelFromXp(stats.xp)
  const pct = Math.min(100, Math.round((into / need) * 100))

  return (
    <div className="plate grid gap-3 p-3 sm:grid-cols-4">
      <div>
        <p className="hud-label">Rank</p>
        <p className="stamp text-2xl text-gold">LV {level}</p>
      </div>
      <div>
        <p className="hud-label">XP</p>
        <p className="font-mono text-lg text-ink">{stats.xp}</p>
        <div className="meter mt-1">
          <span style={{ width: `${pct}%` }} />
        </div>
      </div>
      <div>
        <p className="hud-label">Locked</p>
        <p className="font-mono text-lg">
          {stats.slipsLocked}{" "}
          <span className="text-mute text-sm">slips</span>
        </p>
      </div>
      <div>
        <p className="hud-label">Streak / best combo</p>
        <p className="font-mono text-lg">
          {stats.streak}d ·{" "}
          <span className="text-gold">
            {stats.bestCombo ? stats.bestCombo.toFixed(2) : "—"}
          </span>
        </p>
      </div>
    </div>
  )
}
