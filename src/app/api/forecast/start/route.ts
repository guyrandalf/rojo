import { NextResponse } from "next/server"
import { z } from "zod"
import { startForecastRun } from "@/lib/forecast/session"
import { humanError } from "../errors"

export const dynamic = "force-dynamic"

const bodySchema = z.object({
  legCount: z.number().int().min(2).max(10).optional(),
  country: z.string().min(2).max(4).optional(),
  bookmaker: z.enum(["sportybet", "football"]).optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  minConfidence: z.number().min(0.5).max(0.95).optional(),
  maxHoursAhead: z.number().min(1).max(336).optional(),
  useForm: z.boolean().optional(),
  includeBasketball: z.boolean().optional(),
})

export async function POST(request: Request) {
  try {
    const json = await request.json().catch(() => ({}))
    const parsed = bodySchema.safeParse(json)
    if (!parsed.success) {
      return NextResponse.json(
        {
          ok: false,
          error: "Some settings look wrong. Check games and dates (max 10 games).",
          details: parsed.error.flatten(),
        },
        { status: 400 }
      )
    }

    const result = await startForecastRun(parsed.data)
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    const { status, error } = humanError(err)
    return NextResponse.json({ ok: false, error }, { status })
  }
}
