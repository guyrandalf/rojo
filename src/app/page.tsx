"use client"

import { useState } from "react"
import { GenerateForm } from "@/components/generate-form"
import { MatchdayHud } from "@/components/matchday-hud"
import { SlipHistory } from "@/components/slip-history"
import { SlipViewer } from "@/components/slip-viewer"

export default function HomePage() {
  const [refreshKey, setRefreshKey] = useState(0)
  const [hudBump, setHudBump] = useState(0)
  const [selectedSlipId, setSelectedSlipId] = useState<string | null>(null)

  return (
    <div className="min-h-screen text-ink">
      <header className="border-b-4 border-black bg-panel">
        <div className="mx-auto flex max-w-[90rem] flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/brand/mark.svg"
              alt="Play Rojo"
              width={52}
              height={52}
              className="h-12 w-12 border-3 border-black shadow-[3px_3px_0_#000] sm:h-14 sm:w-14"
            />
            <div>
              <p className="stamp text-xl leading-none tracking-wide sm:text-2xl">
                PLAY ROJO
              </p>
              <p className="mt-1 text-sm font-semibold text-mute">
                Pick games · Get booking code
              </p>
            </div>
          </div>
          <p className="border-2 border-black bg-black px-3 py-1.5 text-sm font-bold text-gold">
            18+ only · Bet wise
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-[90rem] space-y-5 px-4 py-6 sm:px-6 sm:py-8">
        <MatchdayHud bump={hudBump} />

        <div className="plate p-5 sm:p-6">
          <h1 className="stamp text-4xl leading-none text-ink sm:text-5xl">
            MAKE YOUR TICKET.
            <span className="block text-rojo">GET THE CODE.</span>
          </h1>
          <p className="mt-4 max-w-2xl text-base font-medium leading-relaxed text-mute sm:text-lg">
            Up to 10 games. AI always analyses (deep markets: halves, corners,
            team goals, and more — not only 1X2). Strength is by analysis, not
            “short odds = sure”. Optional basketball. Open old codes on the
            right to change games.
          </p>
        </div>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
          <div className="min-w-0 space-y-5">
            {selectedSlipId ? (
              <SlipViewer
                slipId={selectedSlipId}
                onClose={() => setSelectedSlipId(null)}
                onRemixed={(id) => {
                  setRefreshKey((k) => k + 1)
                  setHudBump((k) => k + 1)
                  setSelectedSlipId(id)
                }}
              />
            ) : (
              <GenerateForm
                onCreated={() => {
                  setRefreshKey((k) => k + 1)
                  setHudBump((k) => k + 1)
                }}
              />
            )}
          </div>
          <SlipHistory
            refreshKey={refreshKey}
            selectedId={selectedSlipId}
            onSelect={(id) => setSelectedSlipId(id)}
          />
        </div>
      </main>

      <footer className="border-t-4 border-black bg-panel">
        <div className="mx-auto max-w-[90rem] px-4 py-4 text-sm font-semibold text-dim sm:px-6">
          Not Sporty company · Odds can change · 18+
        </div>
      </footer>
    </div>
  )
}
