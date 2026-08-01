import "server-only"
import { db } from "@/lib/db"
import type { Prisma } from "@/generated/prisma/client"

/**
 * Two-tier cache for TheSportsDB lookups.
 *
 * L1 is per-instance memory, which is free but dies with the instance. Once a
 * run is split across many short requests there is no guarantee two steps land
 * on the same instance, so L2 is Postgres. That matters more than it sounds:
 * the free TSDB demo key rate-limits hard, and a cold cache means every step
 * pays full price.
 *
 * A cached `null` is meaningful — it records "we looked and found nothing" —
 * so reads distinguish a miss from a negative hit. Payloads are wrapped in
 * `{ v }` so the Json column is never SQL NULL and we avoid Prisma's
 * DbNull/JsonNull split.
 */

const TTL_MS = 30 * 60 * 1000

type Wrapped = { v: unknown }

const memory = new Map<string, { at: number; value: unknown }>()

export type CacheRead<T> = { hit: true; value: T | null } | { hit: false }

export async function cacheRead<T>(key: string): Promise<CacheRead<T>> {
  const local = memory.get(key)
  if (local) {
    if (Date.now() - local.at <= TTL_MS) {
      return { hit: true, value: local.value as T | null }
    }
    memory.delete(key)
  }

  try {
    const row = await db.formCache.findUnique({ where: { key } })
    if (!row) return { hit: false }
    if (row.expiresAt.getTime() <= Date.now()) return { hit: false }

    const value = (row.payload as Wrapped | null)?.v ?? null
    memory.set(key, { at: Date.now(), value })
    return { hit: true, value: value as T | null }
  } catch {
    // Cache is best effort. A DB hiccup should cost a refetch, not the run.
    return { hit: false }
  }
}

export async function cacheWrite<T>(key: string, value: T | null): Promise<void> {
  memory.set(key, { at: Date.now(), value })

  const payload = { v: value ?? null } as unknown as Prisma.InputJsonObject
  const expiresAt = new Date(Date.now() + TTL_MS)

  try {
    await db.formCache.upsert({
      where: { key },
      create: { key, payload, expiresAt },
      update: { payload, expiresAt },
    })
  } catch {
    // Ignore — L1 still holds it for this instance.
  }
}

/** Opportunistic sweep, called once per run from the scan phase. */
export async function pruneFormCache(): Promise<void> {
  try {
    await db.formCache.deleteMany({ where: { expiresAt: { lt: new Date() } } })
  } catch {
    // Non-fatal.
  }
}
