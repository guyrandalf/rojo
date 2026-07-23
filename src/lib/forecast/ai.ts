import "server-only"
import { generateObject } from "ai"
import { createXai } from "@ai-sdk/xai"
import { z } from "zod"
import type { CandidatePick } from "@/lib/sporty/types"

function hasXaiKey(): boolean {
  return Boolean(process.env.XAI_API_KEY?.trim())
}

export function isAiConfigured(): boolean {
  return hasXaiKey()
}

const selectionSchema = z.object({
  overview: z
    .string()
    .describe(
      "2-4 sentences: overall slip thesis, risk of the multi, what you optimized for"
    ),
  picks: z
    .array(
      z.object({
        candidateIndex: z
          .number()
          .int()
          .describe("Index into the candidates array you were given"),
        reasoning: z
          .string()
          .describe(
            "3-5 sentences of plain-English analysis: why this pick, what the numbers imply, risks, why it fits a multi"
          ),
        risk: z
          .string()
          .describe("One sentence main failure mode for this leg"),
      })
    )
    .min(1),
})

function serializeCandidate(p: CandidatePick, index: number) {
  return {
    candidateIndex: index,
    match: `${p.homeTeam} vs ${p.awayTeam}`,
    tournament: p.tournament ?? "Unknown competition",
    kickoffUtc: p.kickoffAt.toISOString(),
    market: p.marketDesc,
    suggestedPick: p.outcomeDesc,
    decimalOdds: Number(p.odds.toFixed(3)),
    bookImpliedProb: Number(p.impliedProb.toFixed(3)),
    statsModelConfidence: Number(p.confidence.toFixed(3)),
    statsModelEdgePp: Number((p.edge * 100).toFixed(1)),
    statsNotes: p.reasoning,
    fullMarketBoard: p.sourceOdds,
    eventId: p.eventId,
  }
}

/**
 * AI is the decision layer (when keyed):
 * 1. Stats engine builds a shortlist of candidates with Poisson + form/H2H.
 * 2. Grok researches that packet and CHOOSES the final legs + writes real reasons.
 * 3. Booking code is only created from AI-approved legs.
 *
 * Without XAI_API_KEY this returns aiEnabled:false and the caller keeps stats picks.
 */
export async function selectPicksWithAi(
  candidates: CandidatePick[],
  legCount: number
): Promise<{
  picks: CandidatePick[]
  aiEnabled: boolean
  overview?: string
  notes?: string
}> {
  if (!hasXaiKey()) {
    return {
      picks: [],
      aiEnabled: false,
      notes:
        "XAI_API_KEY not set. Stats shortlist is ready, but AI cannot choose legs until you add a SpaceXAI key.",
    }
  }

  if (candidates.length === 0) {
    return { picks: [], aiEnabled: true, notes: "No candidates for AI." }
  }

  // Cap packet size for the model
  const pool = candidates.slice(0, Math.min(candidates.length, 28))
  const payload = pool.map(serializeCandidate)

  try {
    const xai = createXai({ apiKey: process.env.XAI_API_KEY! })
    // Prefer responses-capable model; fall back name if needed
    const model = xai("grok-4.5")

    const { object } = await generateObject({
      model,
      schema: selectionSchema,
      temperature: 0.35,
      prompt: `You are Rojo, a cautious football multi-bet analyst for a personal tool.

You are NOT allowed to invent injuries, lineups, suspensions, weather, or scores you were not given.
You MUST only select from the candidateIndex values provided.
You MUST pick exactly ${legCount} legs when possible (or fewer only if the pool is too weak).
At most ONE pick per match (same eventId must not appear twice).
This desk is HIGH-PROBABILITY: prefer the highest bookImpliedProb / statsModelConfidence legs (aim ~70%+ chance), not longshots or thin edges.
Be honest about variance: a ${legCount}-fold multi compounds risk even with short prices.

For each chosen leg, write a REAL explanation a punter can read:
- what the book price implies
- what the stats model says (λ / edge / form notes if present)
- why you still like or tolerate the pick in a multi
- the main way this leg loses

Candidates (JSON):
${JSON.stringify(payload, null, 2)}

Return structured picks with candidateIndex pointing into that list.`,
    })

    const usedEvents = new Set<string>()
    const final: CandidatePick[] = []

    for (const row of object.picks) {
      if (final.length >= legCount) break
      const base = pool[row.candidateIndex]
      if (!base) continue
      if (usedEvents.has(base.eventId)) continue
      usedEvents.add(base.eventId)

      const risk = row.risk?.trim()
      const reasoning = [
        row.reasoning.trim(),
        risk ? `Main risk: ${risk}` : null,
        `Stats model: conf ${(base.confidence * 100).toFixed(0)}%, edge ${(base.edge * 100).toFixed(1)}pp @ ${base.odds.toFixed(2)}.`,
      ]
        .filter(Boolean)
        .join(" ")

      final.push({
        ...base,
        reasoning,
      })
    }

    if (final.length < Math.min(2, legCount)) {
      return {
        picks: [],
        aiEnabled: true,
        notes: "AI returned too few valid legs; falling back to stats selection.",
        overview: object.overview,
      }
    }

    return {
      picks: final,
      aiEnabled: true,
      overview: object.overview,
      notes: `AI selected ${final.length} legs from ${pool.length} stats candidates.`,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI selection failed"
    return {
      picks: [],
      aiEnabled: false,
      notes: msg,
    }
  }
}

/** @deprecated use selectPicksWithAi — kept name alias for clarity in older imports */
export async function enrichPicksWithAi(picks: CandidatePick[]) {
  return {
    picks,
    aiEnabled: false,
    notes: "enrichPicksWithAi is deprecated; selection is selectPicksWithAi.",
  }
}
