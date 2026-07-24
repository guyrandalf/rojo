"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { recordLockIn } from "@/lib/game-stats"

type OutcomeOpt = {
  outcomeId: string
  outcomeDesc: string
  odds: number
  probability: number | null
  snapshotOnly?: boolean
}

type MarketOpt = {
  marketId: string
  marketDesc: string
  specifier: string | null
  line: string | null
  outcomes: OutcomeOpt[]
}

type Selected = {
  marketId: string
  marketDesc: string
  outcomeId: string
  outcomeDesc: string
  specifier: string | null
  odds: number
  confidence: number
  edge: number | null
  reasoning: string | null
}

type Leg = {
  pickId: string
  eventId: string
  homeTeam: string
  awayTeam: string
  tournament: string | null
  kickoffAt: string | null
  selected: Selected
  markets: MarketOpt[]
  live: boolean
}

type SlipMeta = {
  id: string
  shareCode: string | null
  shareUrl: string | null
  totalOdds: number | null
  status: string
  label: string | null
  bookmaker: string
  country: string
  notes: string | null
  createdAt: string
}

type DraftLeg = {
  eventId: string
  homeTeam: string
  awayTeam: string
  tournament: string | null
  kickoffAt: string | null
  marketId: string
  marketDesc: string
  outcomeId: string
  outcomeDesc: string
  specifier: string | null
  odds: number
  confidence: number
  edge: number | null
  reasoning: string | null
  markets: MarketOpt[]
  live: boolean
  originalKey: string
}

function selectionKey(s: {
  marketId: string
  outcomeId: string
  specifier: string | null
}) {
  return `${s.marketId}|${s.specifier ?? ""}|${s.outcomeId}`
}

export function SlipViewer({
  slipId,
  onClose,
  onRemixed,
}: {
  slipId: string
  onClose: () => void
  onRemixed?: (newSlipId: string) => void
}) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [slip, setSlip] = useState<SlipMeta | null>(null)
  const [draft, setDraft] = useState<DraftLeg[]>([])
  const [bookmaker, setBookmaker] = useState<"sportybet" | "football">(
    "sportybet"
  )
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [remixed, setRemixed] = useState<{
    slipId: string
    code: string
  } | null>(null)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setSaveError(null)
    try {
      const res = await fetch(`/api/slips/${slipId}?board=1`)
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "Failed to load")

      const s = data.slip
      setSlip({
        id: s.id,
        shareCode: s.shareCode,
        shareUrl: s.shareUrl,
        totalOdds: s.totalOdds,
        status: s.status,
        label: s.label,
        bookmaker: s.bookmaker,
        country: s.country,
        notes: s.notes,
        createdAt: s.createdAt,
      })
      setBookmaker(
        s.bookmaker === "football" ? "football" : "sportybet"
      )

      const legs = (data.legs as Leg[]).map((leg) => ({
        eventId: leg.eventId,
        homeTeam: leg.homeTeam,
        awayTeam: leg.awayTeam,
        tournament: leg.tournament,
        kickoffAt: leg.kickoffAt
          ? typeof leg.kickoffAt === "string"
            ? leg.kickoffAt
            : new Date(leg.kickoffAt).toISOString()
          : null,
        marketId: leg.selected.marketId,
        marketDesc: leg.selected.marketDesc,
        outcomeId: leg.selected.outcomeId,
        outcomeDesc: leg.selected.outcomeDesc,
        specifier: leg.selected.specifier,
        odds: leg.selected.odds,
        confidence: leg.selected.confidence,
        edge: leg.selected.edge,
        reasoning: leg.selected.reasoning,
        markets: leg.markets,
        live: leg.live,
        originalKey: selectionKey(leg.selected),
      }))
      setDraft(legs)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load slip")
    } finally {
      setLoading(false)
    }
  }, [slipId])

  useEffect(() => {
    void load()
  }, [load])

  // Only show the new-code banner while the slip it belongs to is open.
  const freshCode = remixed && remixed.slipId === slipId ? remixed.code : null

  const dirty = useMemo(
    () =>
      draft.some(
        (d) =>
          selectionKey({
            marketId: d.marketId,
            outcomeId: d.outcomeId,
            specifier: d.specifier,
          }) !== d.originalKey
      ),
    [draft]
  )

  const combinedOdds = useMemo(
    () => draft.reduce((acc, d) => acc * d.odds, 1),
    [draft]
  )

  function selectOutcome(eventId: string, market: MarketOpt, outcome: OutcomeOpt) {
    setRemixed(null)
    setDraft((prev) =>
      prev.map((leg) => {
        if (leg.eventId !== eventId) return leg
        const implied =
          outcome.probability && outcome.probability > 0
            ? outcome.probability
            : 1 / outcome.odds
        return {
          ...leg,
          marketId: market.marketId,
          marketDesc: market.marketDesc,
          outcomeId: outcome.outcomeId,
          outcomeDesc: outcome.outcomeDesc,
          specifier: market.specifier,
          odds: outcome.odds,
          confidence: implied,
          edge: 0,
          reasoning: `Edited pick: ${outcome.outcomeDesc} @ ${outcome.odds.toFixed(2)} (${market.marketDesc}).`,
        }
      })
    )
  }

  async function saveRemix() {
    if (!slip) return
    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch("/api/slips/remix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceSlipId: slip.id,
          bookmaker,
          country: slip.country,
          legs: draft.map((d) => ({
            eventId: d.eventId,
            marketId: d.marketId,
            outcomeId: d.outcomeId,
            specifier: d.specifier,
            homeTeam: d.homeTeam,
            awayTeam: d.awayTeam,
            tournament: d.tournament,
            kickoffAt: d.kickoffAt,
            marketDesc: d.marketDesc,
            outcomeDesc: d.outcomeDesc,
            odds: d.odds,
            impliedProb: 1 / d.odds,
            confidence: d.confidence,
            edge: d.edge ?? 0,
            reasoning: d.reasoning,
          })),
        }),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "Remix failed")
      if (data.slip.shareCode) {
        setRemixed({ slipId: data.slip.id, code: data.slip.shareCode })
      }
      recordLockIn({
        legs: data.slip.picks?.length ?? draft.length,
        totalOdds: data.slip.totalOdds ?? combinedOdds,
        code: data.slip.shareCode,
      })
      onRemixed?.(data.slip.id)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Remix failed")
    } finally {
      setSaving(false)
    }
  }

  async function copy(text: string) {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <section className="plate overflow-clip">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b-3 border-black bg-panel-2 px-4 py-3">
        <div>
          <p className="hud-label text-base">Change this ticket</p>
          <h2 className="ticket-code text-3xl">
            {slip?.shareCode ?? (loading ? "…" : "—")}
          </h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void load()} className="btn-chip">
            Refresh odds
          </button>
          <button type="button" onClick={onClose} className="btn-chip">
            Go back
          </button>
        </div>
      </div>

      {freshCode && (
        <div className="border-b-3 border-black bg-rojo px-4 py-4">
          <p className="text-base font-bold text-white/80">New booking code</p>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <p className="ticket-code text-3xl text-white sm:text-4xl">
              {freshCode}
            </p>
            <button
              type="button"
              onClick={() => void copy(freshCode)}
              className="border-3 border-black bg-gold px-4 py-2 text-base font-bold text-black"
            >
              {copied ? "Copied!" : "Copy code"}
            </button>
          </div>
          <p className="mt-2 text-sm font-semibold text-white/85">
            This ticket is loaded below. The old code is still under My codes.
          </p>
        </div>
      )}

      {loading && (
        <p className="px-4 py-8 font-mono text-sm text-mute">
          LOADING BOARD…
        </p>
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
              <p className="hud-label text-base">Old total odds</p>
              <p className="stamp text-3xl text-gold">
                {slip.totalOdds?.toFixed(2) ?? "—"}
              </p>
            </div>
            <div className="px-4 py-4 sm:border-r-3 sm:border-black">
              <p className="hud-label text-base">New total odds</p>
              <p className="stamp text-3xl">
                {combinedOdds.toFixed(2)}
                {dirty && (
                  <span className="ml-2 text-sm font-bold text-rojo">changed</span>
                )}
              </p>
            </div>
            <div className="col-span-2 border-t-3 border-black px-4 py-4 sm:col-span-1 sm:border-t-0">
              <p className="hud-label text-base">Betting site</p>
              <select
                value={bookmaker}
                onChange={(e) =>
                  setBookmaker(e.target.value as "sportybet" | "football")
                }
                className="mt-1 w-full sm:max-w-[220px]"
              >
                <option value="football">Football.com</option>
                <option value="sportybet">SportyBet</option>
              </select>
            </div>
          </div>

          <div className="space-y-3 p-4">
            {draft.map((leg, idx) => {
              const currentKey = selectionKey(leg)
              const changed = currentKey !== leg.originalKey
              return (
                <div key={leg.eventId} className="leg-slot p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-bold text-gold">
                        Game {idx + 1}
                        {changed ? " · you changed this" : ""}
                        {!leg.live ? " · old prices" : ""}
                      </p>
                      <p className="stamp text-xl leading-tight sm:text-2xl">
                        {leg.homeTeam}{" "}
                        <span className="font-sans text-base text-mute">vs</span>{" "}
                        {leg.awayTeam}
                      </p>
                      <p className="font-mono text-[11px] text-mute">
                        {leg.tournament ?? "—"}
                        {leg.kickoffAt
                          ? ` · ${new Date(leg.kickoffAt).toLocaleString()}`
                          : ""}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="stamp text-xl text-rojo">{leg.outcomeDesc}</p>
                      <p className="font-mono text-lg">@{leg.odds.toFixed(2)}</p>
                    </div>
                  </div>

                  {leg.markets.length === 0 ? (
                    <p className="mt-3 font-mono text-xs text-mute">
                      No alts on the board right now.
                    </p>
                  ) : (
                    <div className="mt-3 space-y-3">
                      {leg.markets.map((market) => (
                        <div key={`${market.marketId}-${market.specifier ?? ""}`}>
                          <p className="hud-label mb-1.5">
                            {market.marketDesc}
                            {market.line ? ` (${market.line})` : ""}
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {market.outcomes.map((o) => {
                              const selected =
                                leg.marketId === market.marketId &&
                                leg.outcomeId === o.outcomeId &&
                                (leg.specifier ?? null) ===
                                  (market.specifier ?? null)
                              return (
                                <button
                                  key={`${market.marketId}-${o.outcomeId}-${o.outcomeDesc}`}
                                  type="button"
                                  onClick={() =>
                                    selectOutcome(leg.eventId, market, o)
                                  }
                                  className={
                                    selected
                                      ? "border-3 border-black bg-gold px-2.5 py-1.5 text-left font-mono text-xs font-bold text-black shadow-[2px_2px_0_#000]"
                                      : "btn-chip"
                                  }
                                >
                                  {o.outcomeDesc}{" "}
                                  <span className="opacity-80">
                                    {o.odds.toFixed(2)}
                                  </span>
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          <div className="sticky bottom-0 z-10 border-t-3 border-black bg-panel-2 px-4 py-3 sm:py-4">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
              <div className="flex items-baseline gap-2">
                <span className="hud-label text-base">New total</span>
                <span className="stamp text-2xl text-gold">
                  {combinedOdds.toFixed(2)}
                </span>
                {dirty && (
                  <span className="text-sm font-bold text-rojo">changed</span>
                )}
              </div>
              {slip.shareCode && (
                <button
                  type="button"
                  onClick={() => void copy(slip.shareCode!)}
                  className="btn-chip ml-auto"
                >
                  {copied ? "Copied!" : "Copy old code"}
                </button>
              )}
              <button
                type="button"
                disabled={saving || draft.length === 0}
                onClick={() => void saveRemix()}
                className="btn-lock w-full sm:w-auto"
              >
                {saving
                  ? "Making code…"
                  : dirty
                    ? "Get new booking code"
                    : "Get same code again"}
              </button>
              {saveError && (
                <p className="w-full bg-rojo px-3 py-2 text-sm font-semibold text-white">
                  {saveError}
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  )
}
