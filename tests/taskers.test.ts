import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { vet, type TaskerProfile, type VettingPolicy } from '../src/trust.js'
import { FixtureTaskers, scoreTasker } from '../src/tools/taskers.js'

const fixturePath = fileURLToPath(new URL('../fixtures/taskers.json', import.meta.url))
const profiles: TaskerProfile[] = JSON.parse(readFileSync(fixturePath, 'utf8'))

const policy: VettingPolicy = {
  minRating: 4.7,
  minJobs: 50,
  requireBackgroundCheck: true,
  requireInsuredFor: { vehicle: true },
  phoneScreenRequired: true,
}

describe('FixtureTaskers', () => {
  const taskers = new FixtureTaskers(profiles)

  it('find returns every profile listing the task class', async () => {
    const found = await taskers.find('vehicle')
    expect(found).toHaveLength(5)
    expect(found.map((p) => p.id).sort()).toEqual(
      ['dev-k', 'jules-t', 'lena-p', 'maria-r', 'sam-o'].sort(),
    )
  })

  it('get returns the profile by id', () => {
    const maria = taskers.get('maria-r')
    expect(maria).toBeDefined()
    expect(maria?.rateCents).toBe(3800)
  })

  it('get returns undefined for an unknown id', () => {
    expect(taskers.get('nobody')).toBeUndefined()
  })
})

describe('vet against the fixture roster', () => {
  const byId = (id: string) => profiles.find((p) => p.id === id)!

  it('maria-r and lena-p pass', () => {
    expect(vet(byId('maria-r'), policy, 'vehicle')).toEqual({ passed: true, failures: [] })
    expect(vet(byId('lena-p'), policy, 'vehicle')).toEqual({ passed: true, failures: [] })
  })

  it('dev-k fails for lacking vehicle insurance', () => {
    expect(vet(byId('dev-k'), policy, 'vehicle')).toEqual({
      passed: false,
      failures: ['NOT_INSURED_FOR_vehicle'],
    })
  })

  it('jules-t fails for rating', () => {
    expect(vet(byId('jules-t'), policy, 'vehicle')).toEqual({
      passed: false,
      failures: ['RATING_BELOW_4.7'],
    })
  })

  it('sam-o fails for jobs and background check, in that order', () => {
    expect(vet(byId('sam-o'), policy, 'vehicle')).toEqual({
      passed: false,
      failures: ['JOBS_BELOW_50', 'NO_BACKGROUND_CHECK'],
    })
  })
})

describe('scoreTasker', () => {
  it('computes rating * 20 + min(jobs, 300) / 10 + yearsActive * 2', () => {
    const maria = profiles.find((p) => p.id === 'maria-r')!
    const lena = profiles.find((p) => p.id === 'lena-p')!
    expect(scoreTasker(maria)).toBeCloseTo(4.9 * 20 + 212 / 10 + 4 * 2)
    expect(scoreTasker(maria)).toBeGreaterThan(scoreTasker(lena))
  })

  it('caps the jobs contribution at 300', () => {
    const devK = profiles.find((p) => p.id === 'dev-k')!
    expect(scoreTasker(devK)).toBeCloseTo(4.8 * 20 + 300 / 10 + 6 * 2)
  })
})
