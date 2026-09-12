import { describe, expect, it } from 'vitest'
import {
  rungOf,
  vet,
  agentCounterparty,
  type TrustEvent,
  type TaskerProfile,
} from '../src/trust.js'

const ev = (kind: 'clean' | 'incident', n: number, id = 'maria-r'): TrustEvent => ({
  counterpartyId: id,
  kind,
  detail: kind,
  at: new Date(Date.UTC(2026, 8, 1 + n)).toISOString(),
})

describe('rungOf', () => {
  it('starts at the baseline with no events', () => {
    expect(rungOf('maria-r', {}, [], 3, 'unknown')).toBe('unknown')
    expect(rungOf(agentCounterparty('restaurant_deposit'), {}, [], 3, 'screened')).toBe('screened')
  })
  it('promotes screened to proven after promoteAfter consecutive clean events', () => {
    const events = [ev('clean', 1), ev('clean', 2), ev('clean', 3)]
    expect(rungOf('maria-r', {}, events, 3, 'screened')).toBe('proven')
    expect(rungOf('maria-r', {}, events.slice(0, 2), 3, 'screened')).toBe('screened')
  })
  it('an incident drops one rung and resets the clean count', () => {
    const events = [
      ev('clean', 1),
      ev('clean', 2),
      ev('clean', 3),
      ev('incident', 4),
      ev('clean', 5),
    ]
    expect(rungOf('maria-r', {}, events, 3, 'screened')).toBe('screened')
  })
  it('never promotes to trusted; trusted comes only from a grant', () => {
    const events = Array.from({ length: 10 }, (_, i) => ev('clean', i))
    expect(rungOf('maria-r', {}, events, 3, 'screened')).toBe('proven')
    expect(rungOf('maria-r', { 'maria-r': { rung: 'trusted' } }, [], 3, 'unknown')).toBe('trusted')
  })
  it('an incident demotes a trusted grant to proven', () => {
    expect(
      rungOf('maria-r', { 'maria-r': { rung: 'trusted' } }, [ev('incident', 1)], 3, 'unknown'),
    ).toBe('proven')
  })
  it('ignores events for other counterparties', () => {
    const events = [ev('clean', 1, 'other'), ev('clean', 2, 'other'), ev('clean', 3, 'other')]
    expect(rungOf('maria-r', {}, events, 3, 'screened')).toBe('screened')
  })
  it('a screened event lifts unknown to screened', () => {
    const screened: TrustEvent = {
      counterpartyId: 'maria-r',
      kind: 'clean',
      detail: 'screened',
      at: ev('clean', 1).at,
    }
    expect(rungOf('maria-r', {}, [screened], 3, 'unknown')).toBe('screened')
  })
  it('the screened event itself does not count toward promotion (M1)', () => {
    const screened: TrustEvent = {
      counterpartyId: 'maria-r',
      kind: 'clean',
      detail: 'screened',
      at: ev('clean', 0).at,
    }
    const twoClean = [screened, ev('clean', 1), ev('clean', 2)]
    expect(rungOf('maria-r', {}, twoClean, 3, 'unknown')).toBe('screened')
    const threeClean = [screened, ev('clean', 1), ev('clean', 2), ev('clean', 3)]
    expect(rungOf('maria-r', {}, threeClean, 3, 'unknown')).toBe('proven')
  })
})

const policy = {
  minRating: 4.7,
  minJobs: 50,
  requireBackgroundCheck: true,
  requireInsuredFor: { vehicle: true },
  phoneScreenRequired: true,
}
const maria: TaskerProfile = {
  id: 'maria-r',
  name: 'Maria R.',
  rating: 4.9,
  jobs: 212,
  backgroundCheck: true,
  insuredFor: ['vehicle', 'home'],
  yearsActive: 4,
  rateCents: 3800,
  phone: '+16155550110',
  taskClasses: ['vehicle', 'errand'],
}

describe('vet', () => {
  it('passes a profile that meets every rule', () => {
    expect(vet(maria, policy, 'vehicle')).toEqual({ passed: true, failures: [] })
  })
  it('names each failing rule independently', () => {
    expect(vet({ ...maria, rating: 4.5 }, policy, 'vehicle').failures).toEqual(['RATING_BELOW_4.7'])
    expect(vet({ ...maria, jobs: 12 }, policy, 'vehicle').failures).toEqual(['JOBS_BELOW_50'])
    expect(vet({ ...maria, backgroundCheck: false }, policy, 'vehicle').failures).toEqual([
      'NO_BACKGROUND_CHECK',
    ])
    expect(vet({ ...maria, insuredFor: ['home'] }, policy, 'vehicle').failures).toEqual([
      'NOT_INSURED_FOR_vehicle',
    ])
  })
  it('does not require insurance for a task class the policy does not list', () => {
    expect(vet({ ...maria, insuredFor: [] }, policy, 'errand').passed).toBe(true)
  })
})
