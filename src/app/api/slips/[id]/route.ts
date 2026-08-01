import { NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { createShareCode } from "@/lib/sporty/client"
import type { Bookmaker } from "@/lib/sporty/types"

export const dynamic = "force-dynamic"

type Params = { params: Promise<{ id: string }> }

export async function GET(_request: Request, { params }: Params) {
  try {
    const { id } = await params

    const slip = await db.betSlip.findUnique({
      where: { id },
      include: { picks: { orderBy: { kickoffAt: "asc" } } },
    })

    if (!slip) {
      return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 })
    }

    return NextResponse.json({ ok: true, slip })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load slip"
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}

const patchSchema = z.object({
  status: z
    .enum(["DRAFT", "CODED", "STAKED", "WON", "LOST", "VOID", "EXPIRED"])
    .optional(),
  regenerateCode: z.boolean().optional(),
  bookmaker: z.enum(["sportybet", "football"]).optional(),
})

export async function PATCH(request: Request, { params }: Params) {
  try {
    const { id } = await params
    const json = await request.json().catch(() => ({}))
    const parsed = patchSchema.safeParse(json)
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const existing = await db.betSlip.findUnique({
      where: { id },
      include: { picks: true },
    })
    if (!existing) {
      return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 })
    }

    let shareCode = existing.shareCode
    let shareUrl = existing.shareUrl
    let status = parsed.data.status ?? existing.status
    const bookmaker = (parsed.data.bookmaker ?? existing.bookmaker) as Bookmaker

    if (parsed.data.regenerateCode) {
      const created = await createShareCode(
        existing.picks.map((p) => ({
          eventId: p.eventId,
          marketId: p.marketId,
          outcomeId: p.outcomeId,
          specifier: p.specifier,
        })),
        { country: existing.country, bookmaker }
      )
      shareCode = created.shareCode
      shareUrl = created.shareURL
      status = "CODED"
    }

    const slip = await db.betSlip.update({
      where: { id },
      data: {
        status,
        shareCode,
        shareUrl,
        bookmaker,
      },
      include: { picks: { orderBy: { kickoffAt: "asc" } } },
    })

    return NextResponse.json({ ok: true, slip })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Update failed"
    return NextResponse.json({ ok: false, error: message }, { status: 502 })
  }
}
