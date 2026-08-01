import { NextResponse } from "next/server"
import { z } from "zod"
import { analyzeEvent } from "@/lib/forecast/session"
import { humanError } from "../errors"

export const dynamic = "force-dynamic"

const bodySchema = z.object({
  runId: z.string().min(1),
  eventId: z.string().min(3),
})

export async function POST(request: Request) {
  try {
    const json = await request.json().catch(() => ({}))
    const parsed = bodySchema.safeParse(json)
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "Bad step request.", details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const result = await analyzeEvent(parsed.data.runId, parsed.data.eventId)
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    const { status, error } = humanError(err)
    return NextResponse.json({ ok: false, error }, { status })
  }
}
