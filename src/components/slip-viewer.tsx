"use client"

import { useCallback, useEffect, useState } from "react"

type ViewPick = {
  id: string
  homeTeam: string
  awayTeam: string
  tournament: string | null
  kickoffAt: string | null
  marketDesc: string
  outcomeDesc: string
  odds: number
  confidence: number
  reasoning: string | null
}

type SlipMeta = {
  id: string
  shareCode: string | null
  shareUrl: string | null
  totalOdds: number | null
  combinedConf: number | null
  status: string
  label: string | null
  bookmaker: string
  country: string
  notes: string | null
  createdAt: string
  picks: ViewPick[]
}

/**
 * Read-only ticket view. Editing legs lives on football.com / SportyBet —
 * load the code there and change games in their slip UI.
 */
export function SlipViewer({
  slipId,
  onClose,
}: {
  slipId: string
  onClose: () => void
}) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [slip, setSlip] = useState<SlipMeta | null>(null)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/slips/${slipId}`)
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "Failed to load")

      const s = data.slip
      setSlip({
        id: s.id,
        shareCode: s.shareCode,
        shareUrl: s.shareUrl,
        totalOdds: s.totalOdds,
        combinedConf: s.combinedConf,
        status: s.status,
        label: s.label,
        bookmaker: s.bookmaker,
        country: s.country,
        notes: s.notes,
        createdAt: s.createdAt,
        picks: (s.picks ?? []).map(
          (p: {
            id: string
            homeTeam: string
            awayTeam: string
            tournament: string | null
            kickoffAt: string | null
            marketDesc: string
            outcomeDesc: string
            odds: number
            confidence: number
            reasoning: string | null
          }) => ({
            id: p.id,
            homeTeam: p.homeTeam,
            awayTeam: p.awayTeam,
            tournament: p.tournament,
            kickoffAt: p.kickoffAt,
            marketDesc: p.marketDesc,
            outcomeDesc: p.outcomeDesc,
            odds: p.odds,
            confidence: p.confidence,
            reasoning: p.reasoning,
          })
        ),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load slip")
    } finally {
      setLoading(false)
    }
  }, [slipId])

  useEffect(() => {
    void load()
  }, [load])

  async function copyCode() {
    if (!slip?.shareCode) return
    await navigator.clipboard.writeText(slip.shareCode)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const siteName = slip?.bookmaker === "football" ? "Football.com" : "SportyBet"

  return (
    <section className="plate overflow-clip">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b-3 border-black bg-panel-2 px-4 py-3">
        <div>
          <p className="hud-label text-base">Your ticket</p>
          <h2 className="ticket-code text-3xl">
            {slip?.shareCode ?? (loading ? "…" : "—")}
          </h2>
        </div>
        <button type="button" onClick={onClose} className="btn-chip">
          Go back
        </button>
      </div>

      {loading && (
        <p className="px-4 py-8 font-mono text-sm text-mute">LOADING…</p>
      )}
      {error && (
        <p className="bg-rojo px-4 py-3 text-sm font-semibold text-white" role="alert">
          {error}
        </p>
      )}

      {!loading && !error && slip && (
        <>
          <div className="grid grid-cols-2 gap-0 border-b-3 border-black sm:grid-cols-3">
            <div className="border-r-3 border-black px-4 py-4">
              <p className="hud-label text-base">Total odds</p>
              <p className="stamp text-3xl text-gold">
                {slip.totalOdds?.toFixed(2) ?? "—"}
              </p>
            </div>
            <div className="px-4 py-4 sm:border-r-3 sm:border-black">
              <p className="hud-label text-base">Games</p>
              <p className="stamp text-3xl">{slip.picks.length}</p>
            </div>
            <div className="col-span-2 border-t-3 border-black px-4 py-4 sm:col-span-1 sm:border-t-0">
              <p className="hud-label text-base">Made on</p>
              <p className="font-mono text-base font-bold">
                {new Date(slip.createdAt).toLocaleString()}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-b-3 border-black bg-panel-2 px-4 py-3">
            {slip.shareCode && (
              <button type="button" onClick={() => void copyCode()} className="btn-chip">
                {copied ? "Copied!" : "Copy code"}
              </button>
            )}
            {slip.shareUrl && (
              <a
                href={slip.shareUrl.replace(/^http:/, "https:")}
                target="_blank"
                rel="noreferrer"
                className="border-3 border-black bg-black px-3 py-2 text-sm font-bold text-white shadow-[2px_2px_0_#000]"
              >
                Open on {siteName}
              </a>
            )}
            <p className="w-full text-sm font-semibold text-mute sm:ml-auto sm:w-auto">
              Want different games? Load the code on {siteName} and edit it there.
            </p>
          </div>

          <div className="space-y-3 p-4">
            {slip.picks.map((p, idx) => (
              <div key={p.id} className="leg-slot p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-gold">Game {idx + 1}</p>
                    <p className="stamp text-xl leading-tight sm:text-2xl">
                      {p.homeTeam}{" "}
                      <span className="font-sans text-base text-mute">vs</span>{" "}
                      {p.awayTeam}
                    </p>
                    <p className="font-mono text-[11px] text-mute">
                      {p.tournament ?? "—"}
                      {p.kickoffAt
                        ? ` · ${new Date(p.kickoffAt).toLocaleString()}`
                        : ""}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="stamp text-xl text-rojo">{p.outcomeDesc}</p>
                    <p className="font-mono text-lg">@{p.odds.toFixed(2)}</p>
                    <p className="text-sm font-bold text-gold">
                      {(p.confidence * 100).toFixed(0)}% sure
                    </p>
                  </div>
                </div>
                <p className="mt-2 text-sm font-semibold text-dim">{p.marketDesc}</p>
                {p.reasoning && (
                  <p className="mt-2 border-l-4 border-rojo pl-3 text-sm leading-relaxed text-mute">
                    {p.reasoning}
                  </p>
                )}
              </div>
            ))}
          </div>

          {slip.notes && (
            <p className="border-t-3 border-black px-4 py-3 text-sm text-mute">
              {slip.notes}
            </p>
          )}
        </>
      )}
    </section>
  )
}
