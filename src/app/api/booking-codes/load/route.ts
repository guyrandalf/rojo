import { NextResponse } from "next/server"
import { z } from "zod"
import { loadShareCode } from "@/lib/sporty/client"

export const dynamic = "force-dynamic"

const bodySchema = z.object({
  code: z.string().min(3).max(20),
  country: z.string().min(2).max(4).optional(),
  bookmaker: z.enum(["sportybet", "football"]).optional(),
})

export async function POST(request: Request) {
  try {
    const json = await request.json()
    const parsed = bodySchema.safeParse(json)
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const data = await loadShareCode(parsed.data.code.trim().toUpperCase(), {
      country: parsed.data.country,
      bookmaker: parsed.data.bookmaker ?? "sportybet",
    })

    return NextResponse.json({ ok: true, data })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Load failed"
    return NextResponse.json({ ok: false, error: message }, { status: 502 })
  }
}
