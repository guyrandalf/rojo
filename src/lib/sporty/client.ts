import "server-only"
import type {
  Bookmaker,
  ShareCreateResponse,
  ShareLoadResponse,
  SportyEvent,
  SportySelection,
  UpcomingEventsResponse,
} from "./types"

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

const BRANDS: Bookmaker[] = ["sportybet", "football"]

function baseUrl(bookmaker: Bookmaker): string {
  return bookmaker === "football"
    ? "https://www.football.com"
    : "https://www.sportybet.com"
}

function referer(bookmaker: Bookmaker, country: string): string {
  return `${baseUrl(bookmaker)}/${country}/`
}

function headers(bookmaker: Bookmaker, country: string): HeadersInit {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": UA,
    Referer: referer(bookmaker, country),
    Origin: baseUrl(bookmaker),
  }
}

function networkMessage(err: unknown, host: string): string {
  const e = err as {
    message?: string
    cause?: { code?: string; message?: string }
  }
  const code = e?.cause?.code
  if (code === "ECONNREFUSED") {
    return `Cannot reach ${host} (connection refused). Network or regional block — trying the sister book if available.`
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return `DNS failed for ${host}.`
  }
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return `Timed out connecting to ${host}.`
  }
  if (e?.message === "fetch failed" || e?.cause?.message) {
    return `Network error talking to ${host}: ${e.cause?.message || e.message || code || "fetch failed"}`
  }
  return err instanceof Error ? err.message : String(err)
}

async function sportyFetch<T>(
  url: string,
  bookmaker: Bookmaker,
  country: string,
  init?: RequestInit
): Promise<T> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        ...headers(bookmaker, country),
        ...(init?.headers ?? {}),
      },
      cache: "no-store",
    })

    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(
        `${bookmaker} API ${res.status}: ${text.slice(0, 200) || res.statusText}`
      )
    }

    return (await res.json()) as T
  } catch (err) {
    if (err instanceof Error && !err.message.includes("API ")) {
      throw new Error(networkMessage(err, baseUrl(bookmaker)))
    }
    throw err
  }
}

function orderBrands(preferred?: Bookmaker): Bookmaker[] {
  if (!preferred) return [...BRANDS]
  return [preferred, ...BRANDS.filter((b) => b !== preferred)]
}

function parseUpcoming(data: UpcomingEventsResponse): SportyEvent[] {
  if (data.bizCode !== 10000 || !data.data?.tournaments) {
    throw new Error(data.message || "Failed to fetch upcoming events")
  }

  const events: SportyEvent[] = []
  for (const t of data.data.tournaments) {
    for (const e of t.events) {
      if (!e.sport?.category?.tournament && t.name) {
        e.sport = {
          ...(e.sport ?? { id: "sr:sport:1", name: "Football" }),
          category: {
            id: e.sport?.category?.id ?? t.id,
            name: e.sport?.category?.name ?? "",
            tournament: { id: t.id, name: t.name },
          },
        }
      }
      events.push(e)
    }
  }
  return events
}

/**
 * Fetch one page of upcoming football fixtures with main markets.
 * Tries preferred book first, then sister Sporty Group brand (same event ids).
 *
 * Note: pages are NOT sorted by kickoff. Early pages are often far-future cups;
 * near-term (today) fixtures often sit on later pages. Prefer
 * {@link fetchUpcomingBoard} when you need the full near board.
 */
export async function fetchUpcomingEvents(options?: {
  country?: string
  pageSize?: number
  pageNum?: number
  marketIds?: string
  /** e.g. sr:sport:1 football, sr:sport:2 basketball */
  sportId?: string
  bookmaker?: Bookmaker
  /** When true (default), fall back to the other Sporty Group brand on network failure */
  fallback?: boolean
}): Promise<SportyEvent[]> {
  const country = options?.country ?? process.env.SPORTY_COUNTRY ?? "ng"
  const pageSize = options?.pageSize ?? 40
  const pageNum = options?.pageNum ?? 1
  const marketIds = options?.marketIds ?? "1,18,29"
  const sportId = options?.sportId ?? "sr:sport:1"
  const brands =
    options?.fallback === false
      ? [options.bookmaker ?? "sportybet"]
      : orderBrands(options?.bookmaker)

  const params = new URLSearchParams({
    sportId,
    marketId: marketIds,
    pageSize: String(pageSize),
    pageNum: String(pageNum),
    productId: "3",
    option: "1",
  })

  const errors: string[] = []

  for (const bookmaker of brands) {
    const url = `${baseUrl(bookmaker)}/api/${country}/factsCenter/pcUpcomingEvents?${params}`
    try {
      const data = await sportyFetch<UpcomingEventsResponse>(
        url,
        bookmaker,
        country
      )
      return parseUpcoming(data)
    } catch (err) {
      errors.push(
        `${bookmaker}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  throw new Error(
    `Could not load fixtures from Sporty Group APIs. ${errors.join(" | ")}`
  )
}

/**
 * Crawl several upcoming pages and merge/dedupe. Needed because the feed is
 * not chronologically ordered — "today" often appears mid-pagination.
 */
export async function fetchUpcomingBoard(options?: {
  country?: string
  bookmaker?: Bookmaker
  marketIds?: string
  sportId?: string
  /** How many pages to crawl (default 8, pageSize 40 → up to ~320 events) */
  maxPages?: number
  pageSize?: number
}): Promise<SportyEvent[]> {
  const maxPages = options?.maxPages ?? 8
  const pageSize = options?.pageSize ?? 40
  const seen = new Set<string>()
  const all: SportyEvent[] = []
  let firstError: string | null = null

  // Parallel batches of 2 to keep latency reasonable
  for (let start = 1; start <= maxPages; start += 2) {
    const pages = [start, start + 1].filter((p) => p <= maxPages)
    const results = await Promise.all(
      pages.map(async (pageNum) => {
        try {
          return await fetchUpcomingEvents({
            country: options?.country,
            bookmaker: options?.bookmaker,
            marketIds: options?.marketIds ?? "1,18,29",
            sportId: options?.sportId ?? "sr:sport:1",
            pageNum,
            pageSize,
          })
        } catch (err) {
          if (!firstError) {
            firstError =
              err instanceof Error ? err.message : String(err)
          }
          return [] as SportyEvent[]
        }
      })
    )

    let added = 0
    for (const batch of results) {
      for (const e of batch) {
        if (seen.has(e.eventId)) continue
        seen.add(e.eventId)
        all.push(e)
        added++
      }
    }

    // Stop early if both pages empty
    if (results.every((r) => r.length === 0) && start > 1) break
    if (added === 0 && start > 2) break
  }

  if (all.length === 0 && firstError) {
    throw new Error(firstError)
  }

  all.sort((a, b) => a.estimateStartTime - b.estimateStartTime)
  return all
}

/** Merge full market boards onto events (deep corners / halves / props). */
export async function enrichEventsWithFullMarkets(
  events: SportyEvent[],
  options?: { country?: string; bookmaker?: Bookmaker; concurrency?: number }
): Promise<SportyEvent[]> {
  const concurrency = options?.concurrency ?? 5
  const out: SportyEvent[] = new Array(events.length)
  let cursor = 0

  async function worker() {
    while (true) {
      const idx = cursor++
      if (idx >= events.length) return
      const base = events[idx]
      const detail = await fetchEventDetail(base.eventId, {
        country: options?.country,
        bookmaker: options?.bookmaker,
      })
      if (detail?.markets?.length) {
        out[idx] = {
          ...base,
          ...detail,
          markets: detail.markets,
          homeTeamName: detail.homeTeamName || base.homeTeamName,
          awayTeamName: detail.awayTeamName || base.awayTeamName,
          sport: detail.sport || base.sport,
        }
      } else {
        out[idx] = base
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, events.length)) }, () =>
      worker()
    )
  )
  return out
}

/**
 * Full prematch event board. Tries preferred book, then sister brand.
 */
export async function fetchEventDetail(
  eventId: string,
  options?: { country?: string; bookmaker?: Bookmaker }
): Promise<SportyEvent | null> {
  const country = options?.country ?? process.env.SPORTY_COUNTRY ?? "ng"
  const brands = orderBrands(options?.bookmaker)
  const params = new URLSearchParams({
    eventId,
    productId: "3",
  })

  for (const bookmaker of brands) {
    const url = `${baseUrl(bookmaker)}/api/${country}/factsCenter/event?${params}`
    try {
      const data = await sportyFetch<{
        bizCode: number
        message: string
        data?: SportyEvent
      }>(url, bookmaker, country)

      if (data.bizCode === 10000 && data.data?.eventId) {
        return data.data
      }
    } catch {
      // try next brand
    }
  }
  return null
}

export async function createShareCode(
  selections: SportySelection[],
  options?: { country?: string; bookmaker?: Bookmaker }
): Promise<{ shareCode: string; shareURL: string; outcomes?: SportyEvent[] }> {
  if (selections.length === 0) {
    throw new Error("selections cannot be empty")
  }

  const country = options?.country ?? process.env.SPORTY_COUNTRY ?? "ng"
  const brands = orderBrands(options?.bookmaker)
  const errors: string[] = []

  for (const bookmaker of brands) {
    const url = `${baseUrl(bookmaker)}/api/${country}/orders/share`
    try {
      const data = await sportyFetch<ShareCreateResponse>(
        url,
        bookmaker,
        country,
        {
          method: "POST",
          body: JSON.stringify({ selections }),
        }
      )

      const ok =
        data.bizCode === 10000 ||
        data.message?.toLowerCase() === "success" ||
        data.message === "Success"

      if (!ok || !data.data?.shareCode) {
        errors.push(`${bookmaker}: ${data.message || "no share code"}`)
        continue
      }

      return {
        shareCode: data.data.shareCode,
        shareURL:
          data.data.shareURL ||
          `${baseUrl(bookmaker)}/${country}/?shareCode=${data.data.shareCode}`,
        outcomes: data.data.outcomes,
      }
    } catch (err) {
      errors.push(
        `${bookmaker}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  throw new Error(`Could not create booking code. ${errors.join(" | ")}`)
}

export async function loadShareCode(
  code: string,
  options?: { country?: string; bookmaker?: Bookmaker }
): Promise<ShareLoadResponse["data"]> {
  const country = options?.country ?? process.env.SPORTY_COUNTRY ?? "ng"
  const brands = orderBrands(options?.bookmaker)
  const errors: string[] = []

  for (const bookmaker of brands) {
    const url = `${baseUrl(bookmaker)}/api/${country}/orders/share/${encodeURIComponent(code)}`
    try {
      const data = await sportyFetch<ShareLoadResponse>(url, bookmaker, country)

      const ok =
        data.bizCode === 10000 ||
        data.message?.toLowerCase() === "success" ||
        data.message === "Success"

      if (ok && data.data) return data.data
      errors.push(`${bookmaker}: ${data.message || "invalid"}`)
    } catch (err) {
      errors.push(
        `${bookmaker}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  throw new Error(`Could not load booking code. ${errors.join(" | ")}`)
}

export function flattenActiveOutcomes(event: SportyEvent) {
  const rows: Array<{
    event: SportyEvent
    market: NonNullable<SportyEvent["markets"]>[number]
    outcome: NonNullable<SportyEvent["markets"]>[number]["outcomes"][number]
  }> = []

  for (const market of event.markets ?? []) {
    if (market.status !== 0) continue
    for (const outcome of market.outcomes ?? []) {
      if (outcome.isActive !== 1) continue
      const odds = Number(outcome.odds)
      if (!Number.isFinite(odds) || odds <= 1) continue
      rows.push({ event, market, outcome })
    }
  }
  return rows
}
