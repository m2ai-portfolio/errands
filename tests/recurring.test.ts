import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { findRecurring, normalizeMerchant, type Transaction } from '../src/tools/recurring.js'

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/transactions.json', import.meta.url), 'utf8'),
) as Transaction[]
const now = new Date('2026-09-11T12:00:00Z')

describe('normalizeMerchant', () => {
  it('collapses variants of the same merchant', () => {
    expect(normalizeMerchant('NETFLIX.COM 866-579-7172')).toBe('Netflix')
    expect(normalizeMerchant('Netflix')).toBe('Netflix')
    expect(normalizeMerchant('SQ *COFFEE CLUB 12')).toBe('Coffee Club')
  })

  it('accepts non-string input defensively without throwing', () => {
    expect(() => normalizeMerchant(12345)).not.toThrow()
    expect(normalizeMerchant(12345)).toBe('')
    expect(normalizeMerchant(null)).toBe('')
    expect(normalizeMerchant(undefined)).toBe('')
  })
})

describe('findRecurring', () => {
  const found = findRecurring(fixture, now)
  it('finds the five recurring charges and nothing else', () => {
    expect(found.map((r) => r.merchant).sort()).toEqual([
      'Clouddrive Plus',
      'Coffee Club',
      'Netflix',
      'Planet Fitness',
      'Spotify',
    ])
  })
  it('detects cadence', () => {
    expect(found.find((r) => r.merchant === 'Netflix')?.cadence).toBe('monthly')
    expect(found.find((r) => r.merchant === 'Coffee Club')?.cadence).toBe('weekly')
  })
  it('ignores pending and void rows', () => {
    expect(found.find((r) => r.merchant === 'Netflix')?.count).toBe(6)
  })
  it('does not flag a single yearly charge', () => {
    expect(found.some((r) => r.merchant === 'Domain Renewal')).toBe(false)
  })
  it('tolerates two days of jitter and ten percent amount drift', () => {
    const base = new Date('2026-03-01T00:00:00Z').getTime()
    const rows: Transaction[] = [0, 30, 61, 90].map((d, i) => ({
      id: `t${i}`,
      description: 'GYM',
      amountCents: 2000 + (i % 2) * 150,
      postedAt: new Date(base + d * 86_400_000).toISOString(),
      status: 'posted',
    }))
    expect(findRecurring(rows, now)).toHaveLength(1)
  })
  it('sorts by amount descending', () => {
    expect(found[0]!.amountCents).toBeGreaterThanOrEqual(found[1]!.amountCents)
  })
  it('ignores a posted transaction dated in the future relative to now', () => {
    const base = new Date('2026-03-01T00:00:00Z').getTime()
    const rows: Transaction[] = [0, 30, 61, 5000].map((d, i) => ({
      id: `f${i}`,
      description: 'FUTURE GYM',
      amountCents: 2000,
      postedAt: new Date(base + d * 86_400_000).toISOString(),
      status: 'posted',
    }))
    const result = findRecurring(rows, now)
    const group = result.find((r) => r.merchant === 'Future Gym')
    expect(group?.count).toBe(3)
    expect(group?.lastChargedAt).toBe(new Date(base + 61 * 86_400_000).toISOString())
  })
})
