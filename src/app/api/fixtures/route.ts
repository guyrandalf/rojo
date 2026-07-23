import { NextResponse } from "next/server"
import { fetchUpcomingEvents } from "@/lib/sporty/client"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const country = searchParams.get("country") ?? process.env.SPORTY_COUNTRY ?? "ng"
    const pageSize = Number(searchParams.get("pageSize") ?? "30")

    const events = await fetchUpcomingEvents({
      country,
      pageSize: Math.min(Math.max(pageSize, 5), 80),
    })

    return NextResponse.json({
      ok: true,
      count: events.length,
      events: events.map((e) => ({
        eventId: e.eventId,
        gameId: e.gameId,
        homeTeam: e.homeTeamName,
        awayTeam: e.awayTeamName,
        tournament: e.sport?.category?.tournament?.name,
        kickoffAt: new Date(e.estimateStartTime).toISOString(),
        markets: (e.markets ?? []).map((m) => ({
          id: m.id,
          desc: m.desc,
          outcomes: (m.outcomes ?? [])
            .filter((o) => o.isActive === 1)
            .map((o) => ({
              id: o.id,
              desc: o.desc,
              odds: Number(o.odds),
              probability: o.probability ? Number(o.probability) : null,
            })),
        })),
      })),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load fixtures"
    return NextResponse.json({ ok: false, error: message }, { status: 502 })
  }
}
