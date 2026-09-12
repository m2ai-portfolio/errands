// The trust ladder. One set of rungs for anyone acting on the user's behalf:
// the agent itself in a spend category, or a named human. Pure functions only.

export type Rung = 'unknown' | 'screened' | 'proven' | 'trusted'
export const RUNG_ORDER: readonly Rung[] = ['unknown', 'screened', 'proven', 'trusted']

export interface TrustEvent {
  counterpartyId: string
  kind: 'clean' | 'incident'
  detail: string
  handover?: true
  at: string
}

export interface CounterpartyGrant {
  rung: Rung
  note?: string
}

export interface VettingPolicy {
  minRating: number
  minJobs: number
  requireBackgroundCheck: boolean
  requireInsuredFor: Record<string, boolean>
  phoneScreenRequired: boolean
}

export interface TaskerProfile {
  id: string
  name: string
  rating: number
  jobs: number
  backgroundCheck: boolean
  insuredFor: string[]
  yearsActive: number
  rateCents: number
  phone: string | null
  taskClasses: string[]
}

export const agentCounterparty = (category: string): string => `agent:${category}`

const step = (rung: Rung, delta: number): Rung => {
  const index = Math.max(0, Math.min(RUNG_ORDER.length - 1, RUNG_ORDER.indexOf(rung) + delta))
  return RUNG_ORDER[index]!
}

// Walk the events in time order. Clean events count toward promotion from
// screened to proven; an incident drops one rung and resets the count.
// Promotion never reaches trusted; only a grant does that.
export function rungOf(
  counterpartyId: string,
  grants: Record<string, CounterpartyGrant>,
  events: readonly TrustEvent[],
  promoteAfter: number,
  baseline: Rung,
): Rung {
  const grant = grants[counterpartyId]
  let rung: Rung = grant ? grant.rung : baseline
  let clean = 0
  const mine = events
    .filter((e) => e.counterpartyId === counterpartyId)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  for (const event of mine) {
    if (event.kind === 'incident') {
      rung = step(rung, -1)
      clean = 0
      continue
    }
    if (event.detail === 'screened') {
      if (rung === 'unknown') {
        rung = 'screened'
      }
      continue
    }
    clean += 1
    if (rung === 'screened' && clean >= promoteAfter) rung = 'proven'
  }
  return rung
}

export function vet(
  profile: TaskerProfile,
  policy: VettingPolicy,
  taskClass: string,
): { passed: boolean; failures: string[] } {
  const failures: string[] = []
  if (profile.rating < policy.minRating) failures.push(`RATING_BELOW_${policy.minRating}`)
  if (profile.jobs < policy.minJobs) failures.push(`JOBS_BELOW_${policy.minJobs}`)
  if (policy.requireBackgroundCheck && !profile.backgroundCheck)
    failures.push('NO_BACKGROUND_CHECK')
  if (policy.requireInsuredFor[taskClass] && !profile.insuredFor.includes(taskClass)) {
    failures.push(`NOT_INSURED_FOR_${taskClass}`)
  }
  return { passed: failures.length === 0, failures }
}
