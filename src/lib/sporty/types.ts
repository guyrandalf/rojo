export type Bookmaker = "sportybet" | "football"

export type SportySelection = {
  eventId: string
  marketId: string
  outcomeId: string
  specifier: string | null
}

export type SportyOutcome = {
  id: string
  odds: string
  probability?: string
  voidProbability?: string
  isActive: number
  desc: string
}

export type SportyMarket = {
  id: string
  product?: number
  desc: string
  status: number
  group?: string
  title?: string
  name?: string
  outcomes: SportyOutcome[]
  specifier?: string | null
  sourceType?: string
}

export type SportyEvent = {
  eventId: string
  gameId?: string
  estimateStartTime: number
  status: number
  matchStatus?: string
  homeTeamId?: string
  homeTeamName: string
  awayTeamId?: string
  awayTeamName: string
  sport?: {
    id: string
    name: string
    category?: {
      id: string
      name: string
      tournament?: { id: string; name: string }
    }
  }
  totalMarketSize?: number
  markets: SportyMarket[]
}

export type SportyTournament = {
  id: string
  name: string
  events: SportyEvent[]
}

export type UpcomingEventsResponse = {
  bizCode: number
  message: string
  data?: {
    totalNum: number
    tournaments: SportyTournament[]
  }
}

export type ShareCreateResponse = {
  bizCode: number
  message: string
  isAvailable?: boolean
  data?: {
    shareCode: string
    shareURL: string
    ticket?: { selections: SportySelection[] }
    outcomes?: SportyEvent[]
    deadline?: number
    userId?: string
  }
}

export type ShareLoadResponse = {
  bizCode: number
  message: string
  data?: {
    shareCode: string
    shareURL?: string
    outcomes?: SportyEvent[]
    unavailableOutcomes?: SportyEvent[]
    deadline?: number
  }
}

export type CandidatePick = {
  eventId: string
  gameId?: string
  homeTeam: string
  awayTeam: string
  tournament?: string
  kickoffAt: Date
  marketId: string
  marketDesc: string
  outcomeId: string
  outcomeDesc: string
  specifier: string | null
  odds: number
  impliedProb: number
  confidence: number
  edge: number
  reasoning: string
  sourceOdds: Record<string, number>
}
