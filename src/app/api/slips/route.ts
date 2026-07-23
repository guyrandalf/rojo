import { NextResponse } from "next/server"
import { db } from "@/lib/db"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const limit = Math.min(Number(searchParams.get("limit") ?? "20"), 50)

    const slips = await db.betSlip.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      include: {
        picks: { orderBy: { kickoffAt: "asc" } },
      },
    })

    return NextResponse.json({ ok: true, slips })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list slips"
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
