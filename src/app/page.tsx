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
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="stamp bg-rojo px-2 py-1 text-xl text-white shadow-[3px_3px_0_#000]">
              ROJO
            </span>
            <div>
              <p className="stamp text-lg leading-none tracking-wide">
                MATCHDAY DESK
              </p>
              <p className="font-mono text-[11px] text-mute">
                LOCK A MULTI · LOAD THE CODE
              </p>
            </div>
          </div>
          <p className="border-2 border-black bg-black px-2 py-1 font-mono text-[11px] text-gold">
            18+ ONLY · PLAY SMART
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-5 px-4 py-6 sm:px-6 sm:py-8">
        <MatchdayHud bump={hudBump} />

        <div className="plate p-4 sm:p-5">
          <h1 className="stamp text-3xl leading-none text-ink sm:text-4xl">
            BUILD THE CARD.
            <span className="block text-rojo">TAKE THE CODE.</span>
          </h1>
          <p className="mt-3 max-w-2xl text-sm text-mute">
            Scan the board, stack short-price legs across your dates, lock the
            multi, walk out with a booking code for SportyBet or Football.com.
            Tap a recent ticket to rework legs and cut a fresh code.
          </p>
        </div>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start">
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
        <div className="mx-auto max-w-6xl px-4 py-3 font-mono text-[11px] text-dim sm:px-6">
          NOT WITH SPORTY GROUP · PRICES MOVE · 18+
        </div>
      </footer>
    </div>
  )
}
