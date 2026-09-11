import { describe, expect, it } from 'vitest'
import { createGate, GateError, type Policy, type SpendRequest } from '../src/gate.js'

const policy: Policy = {
  enabled: true,
  perTransactionCapCents: 2000,
  dailyCapCents: 2500,
  weeklyCapCents: 4000,
  approvalTtlMinutes: 30,
  categories: {
    call: 'allow',
    restaurant_deposit: 'confirm',
    gift: 'forbid',
  },
}

const t0 = new Date('2026-09-12T18:00:00Z')
const minutes = (n: number) => new Date(t0.getTime() + n * 60_000)
const days = (n: number) => minutes(n * 24 * 60)

const deposit = (overrides: Partial<SpendRequest> = {}): SpendRequest => ({
  merchant: 'Bella Cucina',
  amountCents: 1500,
  category: 'restaurant_deposit',
  ...overrides,
})

function reasonOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    if (error instanceof GateError) return error.reason
    throw error
  }
  throw new Error('expected a GateError')
}

describe('evaluate', () => {
  it('allows a $0 phone call without asking the human', () => {
    const gate = createGate(policy)
    const result = gate.evaluate(deposit({ category: 'call', amountCents: 0 }), t0)
    expect(result.decision).toBe('allow')
  })

  it('asks the human before a deposit in a confirm category', () => {
    const result = createGate(policy).evaluate(deposit(), t0)
    expect(result).toEqual({ decision: 'confirm', reason: 'CONFIRM_CATEGORY' })
  })

  it('forbids a forbidden category', () => {
    expect(createGate(policy).evaluate(deposit({ category: 'gift' }), t0)).toEqual({
      decision: 'forbid',
      reason: 'CATEGORY_FORBIDDEN',
    })
  })

  it('fails closed on a category the policy does not know', () => {
    expect(createGate(policy).evaluate(deposit({ category: 'jewelry' }), t0).reason).toBe(
      'UNKNOWN_CATEGORY',
    )
  })

  it('forbids everything when the kill switch is off', () => {
    const gate = createGate({ ...policy, enabled: false })
    expect(gate.evaluate(deposit({ category: 'call', amountCents: 0 }), t0).reason).toBe(
      'KILL_SWITCH',
    )
  })

  it('forbids a single charge over the per-transaction cap', () => {
    expect(createGate(policy).evaluate(deposit({ amountCents: 2001 }), t0).reason).toBe(
      'OVER_TRANSACTION_CAP',
    )
  })

  it('rejects negative, fractional or non-finite amounts', () => {
    const gate = createGate(policy)
    for (const amountCents of [-1, 10.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(gate.evaluate(deposit({ amountCents }), t0).reason).toBe('INVALID_AMOUNT')
    }
  })

  it('forbids a second charge that would break the rolling 24-hour cap', () => {
    const gate = createGate(policy)
    const first = gate.requestApproval(deposit(), t0)
    gate.commit(deposit(), t0, first.code)
    expect(gate.evaluate(deposit({ amountCents: 1100 }), minutes(60)).reason).toBe(
      'OVER_DAILY_CAP',
    )
    expect(gate.evaluate(deposit({ amountCents: 1000 }), minutes(60)).decision).toBe('confirm')
  })

  it('counts only the last 7 days toward the weekly cap', () => {
    const gate = createGate(policy)
    for (const at of [t0, days(2)]) {
      const approval = gate.requestApproval(deposit(), at)
      gate.commit(deposit(), at, approval.code)
    }
    expect(gate.evaluate(deposit({ amountCents: 1500 }), days(4)).reason).toBe('OVER_WEEKLY_CAP')
    expect(gate.evaluate(deposit({ amountCents: 1500 }), days(7.1)).decision).toBe('confirm')
  })
})

describe('approvals', () => {
  it('issues codes of at least 6 digits that expire after the policy TTL', () => {
    const approval = createGate(policy).requestApproval(deposit(), t0)
    expect(approval.code).toMatch(/^\d{6,}$/)
    expect(approval.expiresAt.getTime() - t0.getTime()).toBe(30 * 60_000)
  })

  it('refuses to issue a code for an allowed or forbidden request', () => {
    const gate = createGate(policy)
    expect(reasonOf(() => gate.requestApproval(deposit({ category: 'call' }), t0))).toBe(
      'NOT_CONFIRMABLE',
    )
    expect(reasonOf(() => gate.requestApproval(deposit({ category: 'gift' }), t0))).toBe(
      'CATEGORY_FORBIDDEN',
    )
  })

  it('binds the code to merchant, amount and category', () => {
    const gate = createGate(policy)
    const { code } = gate.requestApproval(deposit(), t0)
    expect(reasonOf(() => gate.commit(deposit({ merchant: 'Other Place' }), t0, code))).toBe(
      'APPROVAL_INVALID',
    )
    expect(reasonOf(() => gate.commit(deposit({ amountCents: 1600 }), t0, code))).toBe(
      'APPROVAL_INVALID',
    )
    expect(gate.ledger()).toHaveLength(0)
  })

  it('rejects an expired code', () => {
    const gate = createGate(policy)
    const { code } = gate.requestApproval(deposit(), t0)
    expect(reasonOf(() => gate.commit(deposit(), minutes(31), code))).toBe('APPROVAL_EXPIRED')
  })

  it('rejects a code used twice', () => {
    const gate = createGate(policy)
    const { code } = gate.requestApproval(deposit(), t0)
    gate.commit(deposit(), t0, code)
    expect(reasonOf(() => gate.commit(deposit(), minutes(1), code))).toBe('APPROVAL_USED')
  })
})

describe('commit', () => {
  it('records an allowed charge without a code', () => {
    const gate = createGate(policy)
    const entry = gate.commit(deposit({ category: 'call', amountCents: 0 }), t0)
    expect(entry).toMatchObject({ merchant: 'Bella Cucina', amountCents: 0, category: 'call' })
    expect(gate.ledger()).toHaveLength(1)
  })

  it('refuses a confirm-category charge with no code', () => {
    expect(reasonOf(() => createGate(policy).commit(deposit(), t0))).toBe('APPROVAL_REQUIRED')
  })

  it('re-checks the caps at commit time, even with a valid code', () => {
    const gate = createGate(policy)
    const early = gate.requestApproval(deposit(), t0)
    const late = gate.requestApproval(deposit({ amountCents: 1100 }), t0)
    gate.commit(deposit(), t0, early.code)
    expect(reasonOf(() => gate.commit(deposit({ amountCents: 1100 }), t0, late.code))).toBe(
      'OVER_DAILY_CAP',
    )
  })

  it('never records a forbidden charge', () => {
    const gate = createGate({ ...policy, enabled: false })
    expect(reasonOf(() => gate.commit(deposit({ category: 'call', amountCents: 0 }), t0))).toBe(
      'KILL_SWITCH',
    )
    expect(gate.ledger()).toHaveLength(0)
  })
})
