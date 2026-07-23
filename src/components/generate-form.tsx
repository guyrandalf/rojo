"use client"

import { useMemo, useState } from "react"
import { recordLockIn } from "@/lib/game-stats"
import { TouchField } from "@/components/touch-field"

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
    bestEffort?: boolean
    requestedLegs?: number
    deliveredLegs?: number
    warnings?: string[]
  } | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const bigTicket = legCount > 10

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
    setInfo(null)
    setCopied(false)
    setPhase("scan")

    const scanTimer = window.setTimeout(() => setPhase("stack"), 600)
    const controller = new AbortController()
    // Client-side guard so we can explain timeouts before Netlify dies silently
    const kill = window.setTimeout(() => controller.abort(), 55_000)

    try {
      // For big tickets, don't send useAi even if box checked (server also enforces)
      const res = await fetch("/api/forecast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          legCount,
          minOdds,
          maxOdds,
          bookmaker,
          useAi: useCoach && legCount <= 10,
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
        errorMessage?: string
        slip?: SlipResult
        eventCount?: number
        candidateCount?: number
        formHits?: number
        dateFrom?: string
        dateTo?: string
        minConfidence?: number
        bestEffort?: boolean
        requestedLegs?: number
        deliveredLegs?: number
        warnings?: string[]
      }

      let data: ForecastResponse
      try {
        data = (await res.json()) as ForecastResponse
      } catch {
        throw new Error(
          res.status === 502 || res.status === 504
            ? "Server took too long or crashed. Try fewer games, lower strength %, or turn off “Help me pick better”."
            : res.ok
              ? "Bad answer from server"
              : `Could not reach server (${res.status})`
        )
      }

      if (!res.ok || !data.ok || !data.slip) {
        const msg =
          (typeof data.error === "string" && data.error) ||
          (typeof data.errorMessage === "string" && data.errorMessage) ||
          (res.status === 502 || res.status === 504
            ? "Took too long. Try fewer games or turn off extra help."
            : `Could not make code (${res.status})`)
        throw new Error(msg)
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
        bestEffort: data.bestEffort,
        requestedLegs: data.requestedLegs,
        deliveredLegs: data.deliveredLegs,
        warnings: data.warnings,
      })

      if (data.warnings?.length) {
        setInfo(data.warnings.join(" "))
      } else if (data.bestEffort) {
        setInfo(
          `You asked for ${data.requestedLegs} games; we built ${data.deliveredLegs} with strong enough picks.`
        )
      }

      recordLockIn({
        legs: data.slip.picks.length,
        totalOdds: data.slip.totalOdds ?? 1,
        code: data.slip.shareCode,
      })
      onCreated?.()
    } catch (err) {
      setPhase("idle")
      if (err instanceof Error && err.name === "AbortError") {
        setError(
          "Took too long (over 55s). Try fewer games, lower strength %, shorter days, or turn off “Help me pick better”."
        )
      } else {
        setError(err instanceof Error ? err.message : "Something went wrong")
      }
    } finally {
      window.clearTimeout(scanTimer)
      window.clearTimeout(kill)
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
      ? "Looking for games…"
      : phase === "stack"
        ? "Adding games…"
        : phase === "lock"
          ? "Code ready"
          : "Ready"

  return (
    <div className="min-w-0 space-y-5">
      <form onSubmit={onSubmit} className="plate overflow-hidden">
        <div className="flex items-center justify-between border-b-3 border-black bg-panel-2 px-4 py-4">
          <h2 className="stamp text-2xl sm:text-3xl">Choose your ticket</h2>
          <span className="border-2 border-black bg-black px-2 py-1 text-sm font-bold text-gold">
            {bookmaker === "sportybet" ? "SportyBet" : "Football.com"}
          </span>
        </div>

        {/* 2 cols so each control has room for − value + (4 cols clipped numbers) */}
        <div className="grid gap-0 sm:grid-cols-2">
          <TouchField
            label="How many games"
            value={legCount}
            onChange={setLegCount}
            min={2}
            max={40}
            step={1}
            decimals={0}
            hint="Up to 40 games"
          />
          <TouchField
            label="How strong (min %)"
            value={minChancePct}
            onChange={setMinChancePct}
            min={50}
            max={90}
            step={1}
            decimals={0}
            hint="Higher = safer looking"
          />
          <TouchField
            label="Smallest odds"
            value={minOdds}
            onChange={setMinOdds}
            min={1.05}
            max={10}
            step={0.05}
            decimals={2}
          />
          <TouchField
            label="Biggest odds"
            value={maxOdds}
            onChange={setMaxOdds}
            min={1.1}
            max={50}
            step={0.05}
            decimals={2}
          />
        </div>

        <div className="grid gap-0 border-t-3 border-black sm:grid-cols-2 lg:grid-cols-3">
          <Field label="From which day">
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
            />
          </Field>
          <Field label="To which day">
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
            />
          </Field>
          <Field label="Betting site">
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

        <div className="flex flex-wrap items-center gap-2 border-t-3 border-black px-4 py-4">
          <span className="hud-label mr-1">Quick days:</span>
          {(
            [
              ["today", "Today"],
              ["weekend", "Weekend"],
              ["3d", "3 days"],
              ["7d", "1 week"],
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

        <div className="border-t-3 border-black px-4 py-4">
          <label className="flex cursor-pointer items-start gap-3 text-base text-mute">
            <input
              type="checkbox"
              checked={useCoach}
              onChange={(e) => setUseCoach(e.target.checked)}
              className="mt-1 h-5 w-5 accent-rojo"
            />
            <span>
              <span className="text-lg font-bold text-ink">
                Help me pick better
              </span>
              <span className="mt-1 block text-base text-mute">
                Extra help on top of normal search. Leave off if you just want
                the code. (Needs special key on the server if you turn it on.)
              </span>
            </span>
          </label>
        </div>

        {bigTicket && (
          <div className="border-t-3 border-black bg-panel-2 px-4 py-3 text-base font-semibold text-gold">
            Big ticket ({legCount} games): may take longer. “Help me pick better”
            is skipped over 10 games so the code can finish. If it fails, lower
            strength % or ask for fewer games.
          </div>
        )}

        <div className="flex flex-wrap items-center gap-4 border-t-3 border-black bg-panel-2 px-4 py-5">
          <button type="submit" disabled={loading} className="btn-lock">
            {loading
              ? phaseLabel
              : `Get booking code (${legCount} games)`}
          </button>
          <div className="min-w-[160px] flex-1">
            <p className="hud-label">Now doing</p>
            <p className="text-lg font-bold text-gold">{phaseLabel}</p>
            <div className="meter mt-2 max-w-xs">
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
            <p className="w-full border-3 border-black bg-rojo px-3 py-3 text-base font-bold text-white">
              {error}
            </p>
          )}
          {info && !error && (
            <p className="w-full border-3 border-black bg-panel px-3 py-3 text-base font-semibold text-gold">
              {info}
            </p>
          )}
        </div>
      </form>

      {result && (
        <section className="plate overflow-hidden">
          <div className="relative grid gap-0 border-b-3 border-black lg:grid-cols-[1fr_auto]">
            <div className="scanlines absolute inset-0 opacity-40" />
            <div className="relative px-4 py-5 sm:px-5">
              <p className="hud-label">
                Your ticket · {result.picks.length} games
              </p>
              <div className="mt-3 flex flex-wrap items-end gap-8">
                <div>
                  <p className="hud-label">Total odds</p>
                  <p className="stamp text-5xl leading-none text-gold">
                    {result.totalOdds?.toFixed(2) ?? "—"}
                  </p>
                </div>
                <div>
                  <p className="hud-label">Chance all win</p>
                  <p className="font-mono text-2xl font-bold">
                    {((result.combinedConf ?? 0) * 100).toFixed(1)}%
                  </p>
                </div>
              </div>
              {meta && (
                <p className="mt-4 text-sm font-semibold text-mute">
                  Days: {meta.dateFrom} → {meta.dateTo}
                  {meta.minConfidence != null
                    ? ` · Strong from ${(meta.minConfidence * 100).toFixed(0)}%`
                    : ""}
                  {` · Checked ${meta.events} matches · Kept ${meta.candidates}`}
                  {meta.bestEffort &&
                  meta.requestedLegs != null &&
                  meta.deliveredLegs != null
                    ? ` · Built ${meta.deliveredLegs} of ${meta.requestedLegs} games`
                    : ""}
                </p>
              )}
            </div>

            {result.shareCode && (
              <div className="relative border-t-3 border-black bg-rojo px-5 py-5 lg:min-w-[260px] lg:border-l-3 lg:border-t-0">
                <p className="text-base font-bold text-white/80">
                  Booking code
                </p>
                <p className="ticket-code mt-2 text-4xl text-white">
                  {result.shareCode}
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={copyCode}
                    className="border-3 border-black bg-gold px-4 py-2 text-base font-bold text-black shadow-[2px_2px_0_#000]"
                  >
                    {copied ? "Copied!" : "Copy code"}
                  </button>
                  {result.shareUrl && (
                    <a
                      href={result.shareUrl.replace(/^http:/, "https:")}
                      target="_blank"
                      rel="noreferrer"
                      className="border-3 border-black bg-black px-4 py-2 text-base font-bold text-white"
                    >
                      Open site
                    </a>
                  )}
                </div>
              </div>
            )}
          </div>

          {result.notes && (
            <div className="border-b-3 border-black px-4 py-3 text-sm text-mute sm:px-5">
              {result.notes}
            </div>
          )}

          <div className="space-y-3 p-4 sm:p-5">
            <p className="stamp text-xl text-mute">Your games</p>
            {result.picks.map((p, i) => (
              <div key={p.id} className="leg-slot p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-gold">
                      Game {i + 1}
                    </p>
                    <p className="stamp text-xl leading-tight sm:text-2xl">
                      {p.homeTeam}{" "}
                      <span className="font-sans text-base text-mute">vs</span>{" "}
                      {p.awayTeam}
                    </p>
                    <p className="mt-1 text-sm font-semibold text-mute">
                      {p.tournament ?? "—"}
                      {p.kickoffAt
                        ? ` · ${new Date(p.kickoffAt).toLocaleString()}`
                        : ""}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="stamp text-2xl text-rojo">{p.outcomeDesc}</p>
                    <p className="font-mono text-xl font-bold tabular-nums">
                      @{p.odds.toFixed(2)}
                    </p>
                    <p className="text-sm font-bold text-gold">
                      {(p.confidence * 100).toFixed(0)}% sure
                    </p>
                  </div>
                </div>
                <p className="mt-2 text-sm font-semibold uppercase text-dim">
                  {p.marketDesc}
                </p>
                {p.reasoning && (
                  <p className="mt-3 border-l-4 border-rojo pl-3 text-base leading-relaxed text-mute">
                    {p.reasoning}
                  </p>
                )}
              </div>
            ))}
          </div>

          <p className="border-t-3 border-black px-4 py-4 text-sm font-semibold text-dim sm:px-5">
            Even strong picks can lose. Many games together is harder. Check the
            site before you put money.
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
    <label className="block border-b-3 border-black px-4 py-4 sm:border-r-3 lg:border-b-0">
      <span className="hud-label mb-2 block text-base">{label}</span>
      {children}
    </label>
  )
}
