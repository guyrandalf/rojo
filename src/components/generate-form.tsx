"use client"

import { useEffect, useMemo, useRef, useState } from "react"
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

/** Games are chosen automatically to reach the target odds; hard cap 10. */
const MAX_LEGS = 10

export function GenerateForm({ onCreated }: { onCreated?: () => void }) {
  const today = useMemo(() => ymd(new Date()), [])
  // The punter states the payout ("5 odds"); the desk finds the safest route.
  const [targetOdds, setTargetOdds] = useState(5)
  const [minChancePct, setMinChancePct] = useState(62)
  const [dateFrom, setDateFrom] = useState(today)
  const [dateTo, setDateTo] = useState(addDays(today, 2))
  const [bookmaker, setBookmaker] = useState<"sportybet" | "football">(
    "football"
  )
  const [includeBasketball, setIncludeBasketball] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<SlipResult | null>(null)
  const [copied, setCopied] = useState(false)
  const [phase, setPhase] = useState<"idle" | "scan" | "stack" | "lock">("idle")
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null
  )
  const [nowScanning, setNowScanning] = useState<string | null>(null)
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
  const resultRef = useRef<HTMLElement>(null)

  // The finished ticket renders below a long form; on mobile it would
  // otherwise sit off-screen when the code arrives.
  useEffect(() => {
    if (result) {
      resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
    }
  }, [result])

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

  async function postJson<T extends { ok?: boolean; error?: string }>(
    url: string,
    body: unknown,
    timeoutMs: number
  ): Promise<T> {
    const controller = new AbortController()
    const kill = window.setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify(body),
      })
      let data: T
      try {
        data = (await res.json()) as T
      } catch {
        throw new Error(
          res.ok
            ? "Bad answer from server"
            : `Could not reach server (${res.status})`
        )
      }
      if (!res.ok || !data.ok) {
        throw new Error(
          (typeof data.error === "string" && data.error) ||
            `Request failed (${res.status})`
        )
      }
      return data
    } finally {
      window.clearTimeout(kill)
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setInfo(null)
    setCopied(false)
    setProgress(null)
    setNowScanning(null)
    setPhase("scan")

    try {
      // Phase 1 — scan the board, get the list of matches to analyse.
      const start = await postJson<{
        ok: boolean
        error?: string
        runId: string
        eventIds: string[]
        warnings?: string[]
      }>(
        "/api/forecast/start",
        {
          legCount: MAX_LEGS,
          bookmaker,
          dateFrom,
          dateTo,
          minConfidence: minChancePct / 100,
          includeBasketball,
        },
        20_000
      )

      // Phase 2 — one short request per match. Two in flight: fast enough,
      // and it keeps the free stats API from rate-limiting us.
      setPhase("stack")
      const eventIds = start.eventIds
      const total = eventIds.length
      let done = 0
      setProgress({ done, total })

      const concurrency = 2
      let cursor = 0

      async function stepWorker() {
        while (cursor < eventIds.length) {
          const idx = cursor++
          const eventId = eventIds[idx]
          // One retry per match; a match that fails twice is skipped, not fatal.
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const step = await postJson<{
                ok: boolean
                error?: string
                homeTeam: string | null
                awayTeam: string | null
              }>("/api/forecast/step", { runId: start.runId, eventId }, 15_000)
              if (step.homeTeam && step.awayTeam) {
                setNowScanning(`${step.homeTeam} vs ${step.awayTeam}`)
              }
              break
            } catch {
              if (attempt === 1) break // give up on this match only
            }
          }
          done++
          setProgress({ done, total })
        }
      }

      await Promise.all(
        Array.from({ length: Math.min(concurrency, total) }, () => stepWorker())
      )

      // Phase 3 — rank what was analysed, create the booking code.
      setNowScanning(null)
      const data = await postJson<{
        ok: boolean
        error?: string
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
      }>(
        "/api/forecast/finish",
        {
          runId: start.runId,
          legCount: MAX_LEGS,
          targetOdds: Math.min(2000, Math.max(2, targetOdds)),
          createCode: true,
        },
        20_000
      )

      if (!data.slip) throw new Error("Could not make code")

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
          `We built ${data.deliveredLegs} games with strong analysis.`
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
        setError("A step took too long. Try again — analysis picks up where it stopped.")
      } else {
        setError(err instanceof Error ? err.message : "Something went wrong")
      }
    } finally {
      setNowScanning(null)
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
        ? progress
          ? `Analyzing match ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`
          : "Analyzing matches…"
        : phase === "lock"
          ? "Code ready"
          : "Ready"

  const meterWidth =
    phase === "idle"
      ? "8%"
      : phase === "scan"
        ? "12%"
        : phase === "stack"
          ? progress && progress.total > 0
            ? `${Math.round(12 + 80 * (progress.done / progress.total))}%`
            : "15%"
          : "100%"

  return (
    <div className="min-w-0 space-y-5">
      <form onSubmit={onSubmit} className="plate overflow-hidden">
        <div className="flex items-center justify-between border-b-3 border-black bg-panel-2 px-4 py-4">
          <h2 className="stamp text-2xl sm:text-3xl">Choose your ticket</h2>
          <span className="border-2 border-black bg-black px-2 py-1 text-sm font-bold text-gold">
            {bookmaker === "sportybet" ? "SportyBet" : "Football.com"}
          </span>
        </div>

        <div className="grid gap-0 sm:grid-cols-2">
          <TouchField
            label="Total odds you want"
            value={targetOdds}
            onChange={(n) => setTargetOdds(Math.min(2000, Math.max(2, n)))}
            min={2}
            max={2000}
            step={1}
            decimals={0}
            hint="We build the safest slip that reaches this. Max 10 games."
          />
          <TouchField
            label="How sure per game (min %)"
            value={minChancePct}
            onChange={setMinChancePct}
            min={50}
            max={90}
            step={1}
            decimals={0}
            hint="Every game must pass this. Lower % = riskier games allowed."
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
              checked={includeBasketball}
              onChange={(e) => setIncludeBasketball(e.target.checked)}
              className="mt-1 h-5 w-5 accent-rojo"
            />
            <span>
              <span className="text-lg font-bold text-ink">
                Include basketball
              </span>
              <span className="mt-1 block text-base text-mute">
                Football is always on. Tick this to also scan basketball
                (winner, totals, handicap). Still max 10 games combined.
              </span>
            </span>
          </label>
        </div>

        <div className="border-t-3 border-black px-4 py-3 text-sm font-semibold text-mute">
          Every match is analysed one by one (Poisson model + recent form +
          H2H) across many markets (corners, halves, team goals, etc.), not
          only 1X2 / Over. Short odds are not treated as “safe” by themselves;
          a 4.00 can score high if analysis likes it.
        </div>

        <div className="flex flex-wrap items-center gap-4 border-t-3 border-black bg-panel-2 px-4 py-5">
          <button
            type="submit"
            disabled={loading}
            className="btn-lock w-full sm:w-auto"
          >
            {loading
              ? phaseLabel
              : `Get booking code (~${targetOdds} odds)`}
          </button>
          <div className="min-w-[160px] flex-1">
            <p className="hud-label">Now doing</p>
            <p className="text-lg font-bold text-gold">{phaseLabel}</p>
            {nowScanning && (
              <p className="truncate text-sm font-semibold text-mute">
                {nowScanning}
              </p>
            )}
            <div className="meter mt-2 max-w-xs">
              <span style={{ width: meterWidth }} />
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
        <section ref={resultRef} className="plate scroll-mt-4 overflow-hidden">
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
                  <p className="hud-label">Combined conviction</p>
                  <p className="font-mono text-2xl font-bold">
                    {((result.combinedConf ?? 0) * 100).toFixed(1)}%
                  </p>
                </div>
              </div>
              {meta && (
                <p className="mt-4 text-sm font-semibold text-mute">
                  Days: {meta.dateFrom} → {meta.dateTo}
                  {meta.minConfidence != null
                    ? ` · Sure from ${(meta.minConfidence * 100).toFixed(0)}%`
                    : ""}
                  {` · Deep-scanned ${meta.events} · Outcomes ${meta.candidates}`}
                  {meta.bestEffort &&
                  meta.requestedLegs != null &&
                  meta.deliveredLegs != null
                    ? ` · Built ${meta.deliveredLegs} of ${meta.requestedLegs}`
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
                    <p className="text-sm font-bold text-gold">Game {i + 1}</p>
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
                <p className="mt-2 text-sm font-semibold text-dim">
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
            Analysis is not a guarantee. 1.05 can lose; 4.00 can win. Check the
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
