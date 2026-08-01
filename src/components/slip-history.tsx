"use client"

import { useCallback, useEffect, useState } from "react"

type HistoryPick = {
  id: string
  homeTeam: string
  awayTeam: string
  outcomeDesc: string
  odds: number
  confidence: number
}

type HistorySlip = {
  id: string
  createdAt: string
  status: string
  label: string | null
  totalOdds: number | null
  shareCode: string | null
  bookmaker: string
  picks: HistoryPick[]
}

export function SlipHistory({
  refreshKey,
  selectedId,
  onSelect,
}: {
  refreshKey?: number
  selectedId?: string | null
  onSelect?: (id: string) => void
}) {
  const [slips, setSlips] = useState<HistorySlip[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/slips?limit=20")
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "Failed to load")
      setSlips(data.slips)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  return (
    <aside id="my-codes" className="plate scroll-mt-4 lg:sticky lg:top-4">
      <div className="flex items-center justify-between border-b-3 border-black bg-panel-2 px-4 py-4">
        <h2 className="stamp text-xl sm:text-2xl">My codes</h2>
        <button type="button" onClick={() => void load()} className="btn-chip">
          {loading ? "…" : "Refresh"}
        </button>
      </div>

      {error && (
        <p className="bg-rojo px-4 py-3 text-base font-bold text-white">
          {error}
        </p>
      )}

      {!loading && slips.length === 0 && (
        <p className="px-4 py-8 text-base font-semibold text-mute">
          No code yet. Use the form to make one.
        </p>
      )}

      <ul className="max-h-[70vh] divide-y-2 divide-black overflow-y-auto">
        {slips.map((s, idx) => {
          const active = selectedId === s.id
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => onSelect?.(s.id)}
                className={
                  active
                    ? "w-full bg-rojo px-4 py-4 text-left text-white"
                    : "w-full bg-panel px-4 py-4 text-left hover:bg-panel-2"
                }
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p
                      className={
                        active
                          ? "font-mono text-lg font-bold tracking-widest text-white"
                          : "ticket-code text-lg"
                      }
                    >
                      {s.shareCode ?? "—"}
                    </p>
                    <p
                      className={
                        active
                          ? "mt-1 text-sm font-semibold text-white/80"
                          : "mt-1 text-sm font-semibold text-mute"
                      }
                    >
                      #{String(slips.length - idx).padStart(2, "0")} ·{" "}
                      {new Date(s.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <p
                    className={
                      active
                        ? "font-mono text-lg font-bold tabular-nums"
                        : "font-mono text-lg font-bold tabular-nums text-gold"
                    }
                  >
                    {s.totalOdds?.toFixed(2) ?? "—"}
                  </p>
                </div>
                <p
                  className={
                    active
                      ? "mt-2 line-clamp-3 text-sm font-medium text-white/85"
                      : "mt-2 line-clamp-3 text-sm font-medium text-mute"
                  }
                >
                  {s.picks
                    .map((p) => `${p.outcomeDesc} ${p.odds.toFixed(2)}`)
                    .join(" · ")}
                </p>
              </button>
            </li>
          )
        })}
      </ul>
      <p className="border-t-3 border-black px-4 py-3 text-sm font-bold text-dim">
        Tap a code to see the games
      </p>
    </aside>
  )
}
