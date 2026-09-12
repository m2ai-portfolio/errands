import { describe, expect, it } from 'vitest'
import { createGate, GateError, type Policy, type SpendRequest } from '../src/gate.js'

const policy: Policy = {
  enabled: true,
  perTransactionCapCents: 10000,
  dailyCapCents: 15000,
  weeklyCapCents: 25000,
  approvalTtlMinutes: 30,
  stepUpCents: 5000,
  promoteAfter: 3,
  notifyCapCents: { restaurant_deposit: 2500 },
  vetting: {
    minRating: 4.7,
    minJobs: 50,
    requireBackgroundCheck: true,
    requireInsuredFor: { vehicle: true },
    phoneScreenRequired: true,
  },
  counterparties: {},
  categories: {
    call: 'allow',
    restaurant_deposit: 'confirm',
    gift: 'forbid',
    hire: 'confirm',
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
    expect(result).toMatchObject({ decision: 'confirm', reason: 'CONFIRM_CATEGORY' })
  })

  it('forbids a forbidden category', () => {
    expect(createGate(policy).evaluate(deposit({ category: 'gift' }), t0)).toMatchObject({
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
    expect(createGate(policy).evaluate(deposit({ amountCents: 10001 }), t0).reason).toBe(
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
    const first = gate.requestApproval(deposit({ amountCents: 9000 }), t0)
    gate.commit(deposit({ amountCents: 9000 }), t0, first.code)
    expect(gate.evaluate(deposit({ amountCents: 6001 }), minutes(60)).reason).toBe('OVER_DAILY_CAP')
    expect(gate.evaluate(deposit({ amountCents: 6000 }), minutes(60)).decision).toBe('confirm')
  })

  it('counts only the last 7 days toward the weekly cap', () => {
    const gate = createGate(policy)
    for (const at of [t0, days(2)]) {
      const approval = gate.requestApproval(deposit({ amountCents: 9000 }), at)
      gate.commit(deposit({ amountCents: 9000 }), at, approval.code)
    }
    expect(gate.evaluate(deposit({ amountCents: 8000 }), days(4)).reason).toBe('OVER_WEEKLY_CAP')
    expect(gate.evaluate(deposit({ amountCents: 8000 }), days(7.1)).decision).toBe('confirm')
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
    const early = gate.requestApproval(deposit({ amountCents: 9000 }), t0)
    const late = gate.requestApproval(deposit({ amountCents: 6001 }), t0)
    gate.commit(deposit({ amountCents: 9000 }), t0, early.code)
    expect(reasonOf(() => gate.commit(deposit({ amountCents: 6001 }), t0, late.code))).toBe(
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

describe('trust ladder', () => {
  const trusted: Policy = { ...policy, counterparties: { 'maria-r': { rung: 'trusted' } } }
  const hire = (overrides: Partial<SpendRequest> = {}): SpendRequest => ({
    merchant: 'Maria R.',
    amountCents: 3800,
    category: 'hire',
    counterpartyId: 'maria-r',
    ...overrides,
  })

  it('refuses to hire a human at rung unknown', () => {
    expect(createGate(policy).evaluate(hire(), t0)).toMatchObject({
      decision: 'forbid',
      reason: 'COUNTERPARTY_UNKNOWN',
      rung: 'unknown',
    })
  })

  it('a first handover always asks, even for a trusted counterparty', () => {
    const gate = createGate(trusted)
    expect(gate.evaluate(hire({ handover: true }), t0)).toMatchObject({
      decision: 'confirm',
      reason: 'FIRST_HANDOVER',
      rung: 'trusted',
    })
  })

  it('a second handover after a clean one runs as notify when under the cap', () => {
    const withCap: Policy = {
      ...trusted,
      notifyCapCents: { ...trusted.notifyCapCents, hire: 5000 },
    }
    const gate = createGate(withCap)
    const code = gate.requestApproval(hire({ handover: true }), t0).code
    gate.commit(hire({ handover: true }), minutes(1), code)
    expect(gate.evaluate(hire({ handover: true }), days(1))).toMatchObject({
      decision: 'notify',
      reason: 'TRACK_RECORD',
    })
  })

  it('the agent earns notify in a category after promoteAfter clean confirmed spends', () => {
    const gate = createGate(policy)
    for (let i = 0; i < 3; i += 1) {
      const code = gate.requestApproval(deposit(), days(i)).code
      gate.commit(deposit(), days(i), code)
    }
    const fourth = gate.evaluate(deposit(), days(3))
    expect(fourth).toMatchObject({ decision: 'notify', reason: 'TRACK_RECORD', rung: 'proven' })
    expect(gate.commit(deposit(), days(3)).approvedBy).toBe('track-record')
  })

  it('an incident resets the track record', () => {
    const gate = createGate(policy)
    for (let i = 0; i < 3; i += 1) {
      const code = gate.requestApproval(deposit(), days(i)).code
      gate.commit(deposit(), days(i), code)
    }
    gate.recordIncident('agent:restaurant_deposit', 'quoted amount mismatch', days(3))
    expect(gate.evaluate(deposit(), days(4)).decision).toBe('confirm')
  })

  it('notify never applies above notifyCapCents', () => {
    const gate = createGate(policy)
    for (let i = 0; i < 3; i += 1) {
      const code = gate.requestApproval(deposit(), days(i)).code
      gate.commit(deposit(), days(i), code)
    }
    expect(gate.evaluate(deposit({ amountCents: 2600 }), days(3)).decision).toBe('confirm')
  })

  it('flags step-up at exactly stepUpCents and not below', () => {
    expect(createGate(policy).evaluate(deposit({ amountCents: 5000 }), t0).stepUp).toBe(true)
    expect(createGate(policy).evaluate(deposit({ amountCents: 4999 }), t0).stepUp).toBe(false)
  })

  it('binds an approval to the counterparty and handover flag', () => {
    const gate = createGate(trusted)
    const code = gate.requestApproval(hire({ handover: true }), t0).code
    expect(reasonOf(() => gate.commit(hire({ handover: false }), minutes(1), code))).toBe(
      'APPROVAL_INVALID',
    )
  })

  it('recordScreened lifts a human from unknown to screened so a hire can be confirmed', () => {
    const gate = createGate(policy)
    gate.recordScreened('maria-r', t0)
    expect(gate.evaluate(hire({ handover: true }), minutes(1))).toMatchObject({
      decision: 'confirm',
      reason: 'FIRST_HANDOVER',
      rung: 'screened',
    })
  })
})
