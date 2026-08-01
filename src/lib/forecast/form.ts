import "server-only"
import type { FormBundle, FormSnapshot, H2HSnapshot } from "./match-model"
import { cacheRead, cacheWrite } from "./form-cache"

/**
 * Best-effort recent form + H2H via TheSportsDB free public API.
 * Demo key "3" is intentionally public; results are partial and name-matching
 * is fuzzy. Failures never throw — callers just get undefined form.
 *
 * Docs: https://www.thesportsdb.com/api.php
 */

const TSDB = "https://www.thesportsdb.com/api/v1/json/3"
const UA = "PlayRojo/1.0 (personal; stats enrichment)"

function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(fc|cf|sc|afc|fk|nk|bk|if|ff|ac|as|ssc|calcio|united|city|town)\b/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function nameScore(a: string, b: string): number {
  const na = normalizeName(a)
  const nb = normalizeName(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  if (na.includes(nb) || nb.includes(na)) return 0.85
  const ta = new Set(na.split(" ").filter((t) => t.length > 2))
  const tb = new Set(nb.split(" ").filter((t) => t.length > 2))
  if (ta.size === 0 || tb.size === 0) return 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  return inter / Math.max(ta.size, tb.size)
}

async function tsdbGet<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${TSDB}${path}`, {
      headers: { Accept: "application/json", "User-Agent": UA },
      // Cache short-lived at the fetch layer too
      next: { revalidate: 1800 },
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

export async function resolveTeamId(
  teamName: string
): Promise<{ id: string; name: string } | null> {
  const key = `team:${normalizeName(teamName)}`
  const cached = await cacheRead<{ id: string; name: string }>(key)
  if (cached.hit) return cached.value

  // Search with a shortened query (drop trailing FC noise)
  const q = encodeURIComponent(teamName.replace(/\s+FC$/i, "").trim())
  const data = await tsdbGet<{
    teams: Array<{ idTeam: string; strTeam: string; strSport?: string }> | null
  }>(`/searchteams.php?t=${q}`)

  const teams = (data?.teams ?? []).filter(
    (t) => !t.strSport || t.strSport.toLowerCase() === "soccer"
  )

  let best: { id: string; name: string } | null = null
  let bestScore = 0.55
  for (const t of teams) {
    const s = nameScore(teamName, t.strTeam)
    if (s > bestScore) {
      bestScore = s
      best = { id: t.idTeam, name: t.strTeam }
    }
  }

  await cacheWrite(key, best)
  return best
}

type LastEvent = {
  idEvent?: string
  strHomeTeam?: string
  strAwayTeam?: string
  intHomeScore?: string | null
  intAwayScore?: string | null
  dateEvent?: string
  strStatus?: string
}

export async function fetchTeamForm(
  teamName: string
): Promise<FormSnapshot | undefined> {
  const resolved = await resolveTeamId(teamName)
  if (!resolved) return undefined

  const formKey = `form:${resolved.id}`
  const cached = await cacheRead<FormSnapshot>(formKey)
  if (cached.hit) return cached.value ?? undefined

  const data = await tsdbGet<{ results: LastEvent[] | null }>(
    `/eventslast.php?id=${resolved.id}`
  )
  const events = (data?.results ?? [])
    .filter((e) => e.intHomeScore != null && e.intAwayScore != null)
    .slice(0, 5)

  if (events.length === 0) {
    await cacheWrite(formKey, null)
    return undefined
  }

  let wins = 0
  let draws = 0
  let losses = 0
  let goalsFor = 0
  let goalsAgainst = 0
  const recent: string[] = []

  for (const e of events) {
    const hs = Number(e.intHomeScore)
    const as = Number(e.intAwayScore)
    const isHome = nameScore(resolved.name, e.strHomeTeam ?? "") >= 0.6
    const gf = isHome ? hs : as
    const ga = isHome ? as : hs
    goalsFor += gf
    goalsAgainst += ga
    if (gf > ga) {
      wins++
      recent.push("W")
    } else if (gf === ga) {
      draws++
      recent.push("D")
    } else {
      losses++
      recent.push("L")
    }
  }

  const played = events.length
  // Weighted: latest results count more
  let weighted = 0
  let weightSum = 0
  events.forEach((e, idx) => {
    const hs = Number(e.intHomeScore)
    const as = Number(e.intAwayScore)
    const isHome = nameScore(resolved.name, e.strHomeTeam ?? "") >= 0.6
    const gf = isHome ? hs : as
    const ga = isHome ? as : hs
    const pts = gf > ga ? 1 : gf === ga ? 0.5 : 0
    const w = events.length - idx
    weighted += pts * w
    weightSum += w
  })

  const formScore = weightSum > 0 ? weighted / weightSum : 0.5
  const snap: FormSnapshot = {
    teamKey: resolved.id,
    teamName: resolved.name,
    played,
    wins,
    draws,
    losses,
    goalsFor,
    goalsAgainst,
    formScore,
    recent: recent.join(""),
  }
  await cacheWrite(formKey, snap)
  return snap
}

export async function fetchH2H(
  homeTeam: string,
  awayTeam: string
): Promise<H2HSnapshot | undefined> {
  const key = `h2h:${normalizeName(homeTeam)}|${normalizeName(awayTeam)}`
  const cached = await cacheRead<H2HSnapshot>(key)
  if (cached.hit) return cached.value ?? undefined

  const [home, away] = await Promise.all([
    resolveTeamId(homeTeam),
    resolveTeamId(awayTeam),
  ])
  if (!home || !away) {
    await cacheWrite(key, null)
    return undefined
  }

  // Last events for home; count meetings vs away.
  const data = await tsdbGet<{ results: LastEvent[] | null }>(
    `/eventslast.php?id=${home.id}`
  )
  // Also pull more history via search if available
  const q = encodeURIComponent(
    `${home.name.replace(/\s+/g, "_")}_vs_${away.name.replace(/\s+/g, "_")}`
  )
  const search = await tsdbGet<{ event: LastEvent[] | null }>(
    `/searchevents.php?e=${q}`
  )

  const pool = [...(data?.results ?? []), ...(search?.event ?? [])]
  const meetings = pool.filter((e) => {
    if (e.intHomeScore == null || e.intAwayScore == null) return false
    const h = e.strHomeTeam ?? ""
    const a = e.strAwayTeam ?? ""
    const involvesHome =
      nameScore(h, home.name) >= 0.55 || nameScore(a, home.name) >= 0.55
    const involvesAway =
      nameScore(h, away.name) >= 0.55 || nameScore(a, away.name) >= 0.55
    return involvesHome && involvesAway
  })

  // Dedupe by idEvent
  const seen = new Set<string>()
  const unique = meetings.filter((e) => {
    const id = e.idEvent ?? `${e.dateEvent}-${e.strHomeTeam}-${e.strAwayTeam}`
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })

  if (unique.length === 0) {
    await cacheWrite(key, null)
    return undefined
  }

  let homeTeamWins = 0
  let awayTeamWins = 0
  let draws = 0
  let goals = 0

  for (const e of unique) {
    const hs = Number(e.intHomeScore)
    const as = Number(e.intAwayScore)
    goals += hs + as
    const homeIsOurHome = nameScore(e.strHomeTeam ?? "", home.name) >= 0.55
    const ourHomeScore = homeIsOurHome ? hs : as
    const ourAwayScore = homeIsOurHome ? as : hs
    if (ourHomeScore > ourAwayScore) homeTeamWins++
    else if (ourHomeScore < ourAwayScore) awayTeamWins++
    else draws++
  }

  const snap: H2HSnapshot = {
    meetings: unique.length,
    homeTeamWins,
    awayTeamWins,
    draws,
    avgGoals: goals / unique.length,
  }
  await cacheWrite(key, snap)
  return snap
}

/**
 * Form + H2H for ONE match. The pipeline analyses a single match per request
 * now, so there is no batch variant: the caller decides how many of these run
 * at once, and the browser keeps that number low enough that the free TSDB key
 * does not start returning 429s.
 */
export async function fetchFormBundle(
  homeTeam: string,
  awayTeam: string
): Promise<FormBundle> {
  try {
    const [homeForm, awayForm, h2h] = await Promise.all([
      fetchTeamForm(homeTeam),
      fetchTeamForm(awayTeam),
      fetchH2H(homeTeam, awayTeam),
    ])
    return { homeForm, awayForm, h2h }
  } catch {
    return {}
  }
}
