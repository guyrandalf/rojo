"use client"

import { useMemo, useState } from "react"
import { recordLockIn } from "@/lib/game-stats"

type PickRow = {
  id: string
  homeTeam: string
  awayTeam: string
  tournament: string | null
  kickoffAt: string | null
  marketDesc: string
  outcomeDesc: string
  odds: number
  confidence: number
  edge: number | null
  reasoning: string | null
}

type SlipResult = {
  id: string
  status: string
  label: string | null
  totalOdds: number | null
  combinedConf: number | null
  shareCode: string | null
  shareUrl: string | null
  bookmaker: string
  country: string
  notes: string | null
  picks: PickRow[]
}

function ymd(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

function addDays(dateYmd: string, days: number): string {
  const [y, m, d] = dateYmd.split("-").map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + days)
  return ymd(dt)
}

export function GenerateForm({ onCreated }: { onCreated?: () => void }) {
  const today = useMemo(() => ymd(new Date()), [])
  const [legCount, setLegCount] = useState(5)
  const [minOdds, setMinOdds] = useState(1.2)
  const [maxOdds, setMaxOdds] = useState(2.0)
  const [minChancePct, setMinChancePct] = useState(60)
  const [dateFrom, setDateFrom] = useState(today)
  const [dateTo, setDateTo] = useState(addDays(today, 2))
  const [bookmaker, setBookmaker] = useState<"sportybet" | "football">(
    "football"
  )
  const [useCoach, setUseCoach] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<SlipResult | null>(null)
  const [copied, setCopied] = useState(false)
  const [phase, setPhase] = useState<"idle" | "scan" | "stack" | "lock">("idle")
  const [meta, setMeta] = useState<{
    events: number
    candidates: number
    formHits?: number
    dateFrom?: string
    dateTo?: string
    minConfidence?: number
  } | null>(null)

  function applyPreset(preset: "today" | "weekend" | "3d" | "7d") {
    const t = ymd(new Date())
    if (preset === "today") {
      setDateFrom(t)
      setDateTo(t)
    } else if (preset === "weekend") {
      const dt = new Date()
      const day = dt.getDay()
      const toSat = (6 - day + 7) % 7
      const sat = addDays(t, toSat === 0 && day !== 6 ? 6 : toSat)
      setDateFrom(sat)
      setDateTo(addDays(sat, 1))
    } else if (preset === "3d") {
      setDateFrom(t)
      setDateTo(addDays(t, 2))
    } else {
      setDateFrom(t)
      setDateTo(addDays(t, 6))
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setCopied(false)
    setPhase("scan")

    const scanTimer = window.setTimeout(() => setPhase("stack"), 600)

    try {
      const res = await fetch("/api/forecast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          legCount,
          minOdds,
          maxOdds,
          bookmaker,
          useAi: useCoach,
          createCode: true,
          markets: ["match_result", "over_under", "btts"],
          dateFrom,
          dateTo,
          minConfidence: minChancePct / 100,
          preferHighProbability: true,
        }),
      })

      type ForecastResponse = {
        ok?: boolean
        error?: string
        slip?: SlipResult
        eventCount?: number
        candidateCount?: number
        formHits?: number
        dateFrom?: string
        dateTo?: string
        minConfidence?: number
      }

      let data: ForecastResponse
      try {
        data = (await res.json()) as ForecastResponse
      } catch {
        throw new Error(
          res.ok ? "Bad response from desk" : `Desk offline (${res.status})`
        )
      }

      if (!res.ok || !data.ok || !data.slip) {
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : `Lock failed (${res.status})`
        )
      }

      setPhase("lock")
      setResult(data.slip)
      setMeta({
        events: data.eventCount ?? 0,
        candidates: data.candidateCount ?? 0,
        formHits: data.formHits,
        dateFrom: data.dateFrom,
        dateTo: data.dateTo,
        minConfidence: data.minConfidence,
      })

      recordLockIn({
        legs: data.slip.picks.length,
        totalOdds: data.slip.totalOdds ?? 1,
        code: data.slip.shareCode,
      })
      onCreated?.()
    } catch (err) {
      setPhase("idle")
      setError(err instanceof Error ? err.message : "Something broke")
    } finally {
      window.clearTimeout(scanTimer)
      setLoading(false)
    }
  }

  async function copyCode() {
    if (!result?.shareCode) return
    await navigator.clipboard.writeText(result.shareCode)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const phaseLabel =
    phase === "scan"
      ? "SCANNING BOARD…"
      : phase === "stack"
        ? "STACKING LEGS…"
        : phase === "lock"
          ? "CARD LOCKED"
          : "READY"

  return (
    <div className="min-w-0 space-y-5">
      <form onSubmit={onSubmit} className="plate overflow-hidden">
        <div className="flex items-center justify-between border-b-3 border-black bg-panel-2 px-4 py-3">
          <h2 className="stamp text-xl">SETUP</h2>
          <span className="border-2 border-black bg-black px-2 py-0.5 font-mono text-[11px] text-gold">
            {bookmaker === "sportybet" ? "SPORTY" : "FOOTBALL.COM"}
          </span>
        </div>

        <div className="grid gap-0 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Legs">
            <input
              type="number"
              min={2}
              max={12}
              value={legCount}
              onChange={(e) => setLegCount(Number(e.target.value))}
            />
          </Field>
          <Field label="Floor %">
            <input
              type="number"
              min={50}
              max={90}
              step={1}
              value={minChancePct}
              onChange={(e) => setMinChancePct(Number(e.target.value))}
            />
          </Field>
          <Field label="Min price">
            <input
              type="number"
              step="0.05"
              min={1.05}
              value={minOdds}
              onChange={(e) => setMinOdds(Number(e.target.value))}
            />
          </Field>
          <Field label="Max price">
            <input
              type="number"
              step="0.05"
              min={1.1}
              value={maxOdds}
              onChange={(e) => setMaxOdds(Number(e.target.value))}
            />
          </Field>
        </div>

        <div className="grid gap-0 border-t-3 border-black sm:grid-cols-2 lg:grid-cols-3">
          <Field label="From">
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
            />
          </Field>
          <Field label="To">
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
            />
          </Field>
          <Field label="Book">
            <select
              value={bookmaker}
              onChange={(e) =>
                setBookmaker(e.target.value as "sportybet" | "football")
              }
            >
              <option value="football">Football.com</option>
              <option value="sportybet">SportyBet</option>
            </select>
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t-3 border-black px-4 py-3">
          <span className="hud-label mr-1">Window</span>
          {(
            [
              ["today", "Today"],
              ["weekend", "Weekend"],
              ["3d", "3 days"],
              ["7d", "Week"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => applyPreset(key)}
              className="btn-chip"
            >
              {label}
            </button>
          ))}
        </div>

        <div className="border-t-3 border-black px-4 py-3">
          <label className="flex cursor-pointer items-start gap-3 text-sm text-mute">
            <input
              type="checkbox"
              checked={useCoach}
              onChange={(e) => setUseCoach(e.target.checked)}
              className="mt-1 h-4 w-4 accent-rojo"
            />
            <span>
              <span className="font-semibold text-ink">Coach assist</span>
              <span className="mt-0.5 block text-mute">
                Optional second pass on the shortlist. Off = pure board scan +
                ranking. Needs a key in env if you flip it on.
              </span>
            </span>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-4 border-t-3 border-black bg-panel-2 px-4 py-4">
          <button type="submit" disabled={loading} className="btn-lock">
            {loading ? phaseLabel : `LOCK ${legCount}-LEG CARD`}
          </button>
          <div className="min-w-[140px] flex-1">
            <p className="hud-label">Status</p>
            <p className="font-mono text-sm text-gold">{phaseLabel}</p>
            <div className="meter mt-1 max-w-xs">
              <span
                style={{
                  width:
                    phase === "idle"
                      ? "8%"
                      : phase === "scan"
                        ? "40%"
                        : phase === "stack"
                          ? "75%"
                          : "100%",
                }}
              />
            </div>
          </div>
          {error && (
            <p className="w-full border-3 border-black bg-rojo px-3 py-2 text-sm font-semibold text-white">
              {error}
            </p>
          )}
        </div>
      </form>

      {result && (
        <section className="plate overflow-hidden">
          <div className="relative grid gap-0 border-b-3 border-black lg:grid-cols-[1fr_auto]">
            <div className="scanlines absolute inset-0 opacity-40" />
            <div className="relative px-4 py-4">
              <p className="hud-label">
                {result.label ?? "CARD"} · {result.status}
                {result.picks.length}-LEG
              </p>
              <div className="mt-2 flex flex-wrap items-end gap-6">
                <div>
                  <p className="hud-label">Combo</p>
                  <p className="stamp text-4xl text-gold leading-none">
                    {result.totalOdds?.toFixed(2) ?? "—"}
                  </p>
                </div>
                <div>
                  <p className="hud-label">Joint hit rate</p>
                  <p className="font-mono text-xl">
                    {((result.combinedConf ?? 0) * 100).toFixed(1)}%
                  </p>
                </div>
              </div>
              {meta && (
                <p className="mt-3 font-mono text-[11px] text-mute">
                  {meta.dateFrom} → {meta.dateTo}
                  {meta.minConfidence != null
                    ? ` · floor ${(meta.minConfidence * 100).toFixed(0)}%`
                    : ""}
                  {` · scanned ${meta.events} · kept ${meta.candidates}`}
                </p>
              )}
            </div>

            {result.shareCode && (
              <div className="relative border-t-3 border-black bg-rojo px-4 py-4 lg:min-w-[240px] lg:border-l-3 lg:border-t-0">
                <p className="hud-label text-white/70">Your code</p>
                <p className="ticket-code mt-1 text-3xl text-white">
                  {result.shareCode}
                </p>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={copyCode}
                    className="border-3 border-black bg-gold px-3 py-1.5 font-mono text-xs font-bold text-black shadow-[2px_2px_0_#000]"
                  >
                    {copied ? "COPIED" : "COPY"}
                  </button>
                  {result.shareUrl && (
                    <a
                      href={result.shareUrl.replace(/^http:/, "https:")}
                      target="_blank"
                      rel="noreferrer"
                      className="border-3 border-black bg-black px-3 py-1.5 font-mono text-xs font-bold text-white"
                    >
                      OPEN BOOK
                    </a>
                  )}
                </div>
              </div>
            )}
          </div>

          {result.notes && (
            <div className="border-b-3 border-black px-4 py-3 font-mono text-xs text-mute">
              {result.notes}
            </div>
          )}

          <div className="space-y-3 p-4">
            <p className="stamp text-lg text-mute">LEG SLOTS</p>
            {result.picks.map((p, i) => (
              <div key={p.id} className="leg-slot p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-mono text-[11px] text-gold">
                      ROUND {i + 1}
                    </p>
                    <p className="stamp text-lg leading-tight">
                      {p.homeTeam}{" "}
                      <span className="text-mute font-sans text-sm">VS</span>{" "}
                      {p.awayTeam}
                    </p>
                    <p className="mt-0.5 font-mono text-[11px] text-mute">
                      {p.tournament ?? "—"}
                      {p.kickoffAt
                        ? ` · ${new Date(p.kickoffAt).toLocaleString()}`
                        : ""}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="stamp text-xl text-rojo">{p.outcomeDesc}</p>
                    <p className="font-mono text-lg tabular-nums">
                      @{p.odds.toFixed(2)}
                    </p>
                    <p className="font-mono text-xs text-gold">
                      {(p.confidence * 100).toFixed(0)}% HIT
                    </p>
                  </div>
                </div>
                <p className="mt-2 font-mono text-[11px] uppercase text-dim">
                  {p.marketDesc}
                </p>
                {p.reasoning && (
                  <p className="mt-2 border-l-4 border-rojo pl-3 text-sm text-mute">
                    {p.reasoning}
                  </p>
                )}
              </div>
            ))}
          </div>

          <p className="border-t-3 border-black px-4 py-3 font-mono text-[11px] text-dim">
            SHORT PRICES STILL LOSE. MULTI RISK STACKS. CHECK THE BOOK BEFORE
            YOU STAKE.
          </p>
        </section>
      )}
    </div>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="block border-b-3 border-black px-4 py-3 sm:border-r-3 lg:border-b-0">
      <span className="hud-label mb-1.5 block">{label}</span>
      {children}
    </label>
  )
}
