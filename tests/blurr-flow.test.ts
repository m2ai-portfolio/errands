import type { BeforeToolCallEvent } from '@strands-agents/sdk'
import { describe, expect, it } from 'vitest'
import { blurrErrand, type Shop } from '../src/errands/blurr.js'
import type { CallRunner } from '../src/errands/types.js'
import { createGate, type Policy, type SpendRequest } from '../src/gate.js'
import { SpendingGateIntervention } from '../src/gate-intervention.js'
import type { StepUpSummary } from '../src/stepup.js'
import type { DepositCharge } from '../src/tools/deposit.js'
import type { ScreenOutcome, ServiceOutcome } from '../src/tools/service.js'
import { FixtureTaskers } from '../src/tools/taskers.js'
import type { TaskerProfile } from '../src/trust.js'
import shopFixtures from '../fixtures/shops.json' with { type: 'json' }
import shippedPolicy from '../policy.json' with { type: 'json' }
import taskerFixtures from '../fixtures/taskers.json' with { type: 'json' }

// Offline end-to-end run of the Blurr errand (oil change plus a hired driver).
// It follows exactly the order the Strands agent loop uses for each tool call:
// intervention first, then (if it allowed or transformed the call) the tool.
// The policy is the shipped policy.json, so the caps and rungs the demo runs
// under are the ones this test proves.

const policy = shippedPolicy as unknown as Policy

const SERVICE: ServiceOutcome = {
  booked: true,
  slot: 'Tuesday 9:00 AM',
  quoteCents: 8900,
  confirmation: 'NL-77',
  notes: 'Bring the car in by 8:45.',
}
const SCREEN: ScreenOutcome = {
  available: true,
  answers: { manual: true, insurance: true, slot: true },
  notes: 'Happy to take it.',
}

const HIRE_REQUEST: SpendRequest = {
  merchant: 'Maria R.',
  amountCents: 3800,
  category: 'hire',
  counterpartyId: 'maria-r',
  handover: true,
}

const NOW = new Date('2026-09-12T15:00:00Z')

type ToolName =
  'find_shops' | 'book_service' | 'pay_service' | 'find_taskers' | 'vet_tasker' | 'hire_tasker'

function harness(opts: { approve?: boolean; outcomes?: unknown[] } = {}) {
  const approve = opts.approve ?? true
  const dialed: string[] = []
  const charges: DepositCharge[] = []
  const prompts: string[] = []
  const stepUps: { code: string; summary: StepUpSummary }[] = []
  const outcomes = opts.outcomes ?? [SERVICE, SCREEN]
  const runCall: CallRunner = async ({ to }) => {
    dialed.push(to)
    return {
      callId: `c${dialed.length}`,
      endedReason: 'assistant-ended-call',
      summary: null,
      structuredData: outcomes[dialed.length - 1] ?? SCREEN,
    }
  }
  const gate = createGate(policy)
  const errand = blurrErrand({
    config: {
      mode: 'demo',
      demoLinesByRole: { full: '+15025550100', open: '+15025550101', switchboard: '+15025550102' },
      liveAllowlist: [],
      customerName: 'Alex',
    },
    gate,
    taskers: new FixtureTaskers(taskerFixtures as TaskerProfile[]),
    shops: shopFixtures as Shop[],
    runCall,
    deposits: {
      charge: async (c) => (
        charges.push(c),
        { id: 'pi_test', status: 'succeeded', amountCents: c.amountCents }
      ),
    },
    voice: { provider: 'cartesia', voiceId: 'v1' },
    vetting: policy.vetting,
    now: () => NOW,
    errandId: 'errand-test',
  })
  const intervention = new SpendingGateIntervention(
    gate,
    errand.spendTools,
    async (p: string) => (prompts.push(p), approve),
    async (code, summary) => {
      stepUps.push({ code, summary })
    },
    () => {},
    () => NOW,
  )

  // One tool call, the way the Strands loop runs it.
  async function use(name: ToolName, input: Record<string, unknown>) {
    const event = {
      toolUse: { name, toolUseId: `${name}-${Math.random()}`, input },
    } as unknown as BeforeToolCallEvent
    const action = await intervention.beforeToolCall(event)
    if (action.type === 'deny') return { denied: action.reason }
    if (action.type === 'transform') action.apply(event)
    const finalInput = event.toolUse.input as never
    if (name === 'find_shops') return errand.handlers.findShops(finalInput)
    if (name === 'book_service') return errand.handlers.book(finalInput)
    if (name === 'pay_service') return errand.handlers.pay(finalInput)
    if (name === 'find_taskers') return errand.handlers.findTaskers(finalInput)
    if (name === 'vet_tasker') return errand.handlers.vet(finalInput)
    return errand.handlers.hire(finalInput)
  }

  return { use, dialed, charges, prompts, stepUps, gate, handlers: errand.handlers }
}

const booking = { vehicle: '2016 Honda Civic', service: 'oil change', window: 'this week' }

describe('blurr errand: oil change plus a hired driver', () => {
  it('books the shop, pays only the quote, and hires only a screened human', async () => {
    const h = harness()

    const shops = (await h.use('find_shops', { service: 'oil change' })) as { id: string }[]
    expect(shops.map((s) => s.id)).toEqual(['nashville-lube', 'music-city-auto'])

    const booked = await h.use('book_service', { shopId: 'nashville-lube', ...booking })
    expect(booked).toMatchObject({
      status: 'completed',
      booked: true,
      slot: 'Tuesday 9:00 AM',
      quoteCents: 8900,
      confirmation: 'NL-77',
    })

    // An amount the shop never quoted dies in the mapper, before any human is asked.
    expect(await h.use('pay_service', { shopId: 'nashville-lube', amountCents: 8000 })).toEqual({
      denied: 'Spending gate: SPEND_INPUT_INVALID: AMOUNT_NOT_QUOTED',
    })
    expect(h.prompts).toHaveLength(0)

    const paid = await h.use('pay_service', { shopId: 'nashville-lube', amountCents: 8900 })
    expect(paid).toMatchObject({ status: 'paid', amountCents: 8900, testMode: true })
    // $89.00 is at or above stepUpCents, so the code went out of band.
    expect(h.stepUps).toHaveLength(1)
    expect(h.stepUps[0]?.summary).toEqual({
      who: 'Nashville Lube and Tire',
      amountCents: 8900,
      category: 'service_booking',
      triedFirst: 'called the shop, which quoted this amount',
    })
    // The stepUp channel only fires when the evaluation said stepUp, so its
    // one entry is the evidence (re-evaluating now would hit the daily cap).

    // Hiring an unscreened human is refused by the mapper, before the gate sees it.
    expect(await h.use('hire_tasker', { taskerId: 'maria-r' })).toEqual({
      denied: 'Spending gate: SPEND_INPUT_INVALID: NOT_SCREENED',
    })

    const taskers = (await h.use('find_taskers', { taskClass: 'vehicle' })) as { id: string }[]
    expect(taskers.map((t) => t.id)).toEqual(['dev-k', 'maria-r', 'lena-p', 'jules-t', 'sam-o'])

    // Top of the list fails vetting on paper, so nobody is phoned.
    const devK = await h.use('vet_tasker', { taskerId: 'dev-k', slot: 'Tuesday 8:00 AM' })
    expect(devK).toEqual({ passed: false, failures: ['NOT_INSURED_FOR_vehicle'] })
    expect(h.dialed).toHaveLength(1)
    // A tasker who failed vetting on paper was never screened, so hiring them
    // is refused by the mapper before any human is asked.
    expect(await h.use('hire_tasker', { taskerId: 'dev-k' })).toEqual({
      denied: 'Spending gate: SPEND_INPUT_INVALID: NOT_SCREENED',
    })

    const maria = await h.use('vet_tasker', { taskerId: 'maria-r', slot: 'Tuesday 8:00 AM' })
    expect(maria).toMatchObject({ passed: true, failures: [] })
    expect(h.dialed).toEqual(['+15025550102', '+15025550102'])
    expect(h.gate.rungFor(HIRE_REQUEST)).toBe('screened')

    const beforeHire = h.gate.evaluate(HIRE_REQUEST, NOW)
    expect(beforeHire).toEqual({
      decision: 'confirm',
      reason: 'FIRST_HANDOVER',
      stepUp: false,
      rung: 'screened',
    })

    const hired = await h.use('hire_tasker', { taskerId: 'maria-r' })
    expect(hired).toMatchObject({
      status: 'hired',
      tasker: 'Maria R.',
      amountCents: 3800,
      slot: 'Tuesday 8:00 AM',
    })

    const ledger = h.gate.ledger()
    expect(ledger.map((e) => `${e.category}:${e.approvedBy}`)).toEqual([
      'call:policy',
      'service_booking:human',
      'call:policy',
      'hire:human',
    ])
    expect(ledger.at(-1)).toMatchObject({
      merchant: 'Maria R.',
      amountCents: 3800,
      category: 'hire',
      counterpartyId: 'maria-r',
      handover: true,
    })
    expect(h.charges).toEqual([
      {
        amountCents: 8900,
        description: 'Errands service: Nashville Lube and Tire',
        idempotencyKey: 'errand-test-nashville-lube-service',
      },
      {
        amountCents: 3800,
        description: 'Errands hire: Maria R.',
        idempotencyKey: 'errand-test-maria-r-hire',
      },
    ])

    // promoteHumanAfter: 1: a human promotes to proven after one clean job.
    expect(h.gate.rungFor(HIRE_REQUEST)).toBe('proven')
    // The handover is no longer a first handover, which is the behavior change
    // that matters. Evaluated a day out, since today's cap is spent: a second
    // hire of a proven person under notifyCapCents.hire (4500) runs as notify.
    const later = new Date('2026-09-13T15:00:00Z')
    expect(h.gate.evaluate(HIRE_REQUEST, later)).toMatchObject({
      decision: 'notify',
      reason: 'TRACK_RECORD',
    })

    // No call ever carried a counterparty: calls are 0-cent, category "call", nothing more.
    for (const entry of ledger.filter((e) => e.category === 'call')) {
      expect(entry.counterpartyId).toBeUndefined()
      expect(entry.handover).toBeUndefined()
      expect(entry.amountCents).toBe(0)
    }
  })

  it('never pays or hires when the human declines', async () => {
    const h = harness({ approve: false })
    await h.use('find_shops', { service: 'oil change' })
    await h.use('book_service', { shopId: 'nashville-lube', ...booking })
    expect(await h.use('pay_service', { shopId: 'nashville-lube', amountCents: 8900 })).toEqual({
      denied: 'Spending gate: HUMAN_DECLINED',
    })
    await h.use('vet_tasker', { taskerId: 'maria-r', slot: 'Tuesday 8:00 AM' })
    expect(await h.use('hire_tasker', { taskerId: 'maria-r' })).toEqual({
      denied: 'Spending gate: HUMAN_DECLINED',
    })
    expect(h.charges).toHaveLength(0)
  })

  it('refuses a shop or tasker it never found, and stops after three calls', async () => {
    const h = harness({ outcomes: [SERVICE, SCREEN, SCREEN] })
    expect(await h.use('book_service', { shopId: 'made-up', ...booking })).toEqual({
      denied: 'Spending gate: SPEND_INPUT_INVALID: UNKNOWN_SHOP',
    })
    expect(await h.use('vet_tasker', { taskerId: 'made-up', slot: 'Tuesday 8:00 AM' })).toEqual({
      denied: 'Spending gate: SPEND_INPUT_INVALID: UNKNOWN_TASKER',
    })
    await h.use('book_service', { shopId: 'nashville-lube', ...booking })
    await h.use('vet_tasker', { taskerId: 'maria-r', slot: 'Tuesday 8:00 AM' })
    await h.use('vet_tasker', { taskerId: 'lena-p', slot: 'Tuesday 8:00 AM' })
    expect(await h.use('book_service', { shopId: 'music-city-auto', ...booking })).toEqual({
      status: 'refused',
      reason: 'CALL_LIMIT_REACHED',
    })
    expect(h.dialed).toHaveLength(3)
  })

  it('a screen the tasker fails leaves them unhireable', async () => {
    const h = harness({
      outcomes: [{ available: true, answers: { manual: false, insurance: true, slot: true } }],
    })
    const screened = await h.use('vet_tasker', { taskerId: 'maria-r', slot: 'Tuesday 8:00 AM' })
    expect(screened).toMatchObject({ passed: false, failures: ['SCREEN_ANSWER_manual'] })
    expect(await h.use('hire_tasker', { taskerId: 'maria-r' })).toEqual({
      denied: 'Spending gate: SPEND_INPUT_INVALID: NOT_SCREENED',
    })
    expect(h.gate.rungFor(HIRE_REQUEST)).toBe('unknown')
  })

  it('records a screen at most once per tasker, even after passing twice', async () => {
    const h = harness({ outcomes: [SCREEN, SCREEN] })
    await h.use('vet_tasker', { taskerId: 'maria-r', slot: 'Tuesday 8:00 AM' })
    await h.use('vet_tasker', { taskerId: 'maria-r', slot: 'Tuesday 8:00 AM' })
    const screenedEvents = h.gate
      .events()
      .filter((e) => e.detail === 'screened' && e.counterpartyId === 'maria-r')
    expect(screenedEvents).toHaveLength(1)
  })

  it('records a screen at most once per tasker, even after failing and passing again', async () => {
    const h = harness({
      outcomes: [
        SCREEN,
        { available: true, answers: { manual: false, insurance: true, slot: true }, notes: '' },
        SCREEN,
      ],
    })
    const first = await h.use('vet_tasker', { taskerId: 'maria-r', slot: 'Tuesday 8:00 AM' })
    expect(first).toMatchObject({ passed: true })
    const second = await h.use('vet_tasker', { taskerId: 'maria-r', slot: 'Tuesday 8:00 AM' })
    expect(second).toMatchObject({ passed: false, failures: ['SCREEN_ANSWER_manual'] })
    const third = await h.use('vet_tasker', { taskerId: 'maria-r', slot: 'Tuesday 8:00 AM' })
    expect(third).toMatchObject({ passed: true })

    const screenedEvents = h.gate
      .events()
      .filter((e) => e.detail === 'screened' && e.counterpartyId === 'maria-r')
    expect(screenedEvents).toHaveLength(1)
    expect(await h.use('hire_tasker', { taskerId: 'maria-r' })).toMatchObject({
      status: 'hired',
      tasker: 'Maria R.',
    })
  })

  it('refuses a second payment for a shop already paid', async () => {
    const h = harness()
    await h.use('book_service', { shopId: 'nashville-lube', ...booking })
    const paid = await h.use('pay_service', { shopId: 'nashville-lube', amountCents: 8900 })
    expect(paid).toMatchObject({ status: 'paid', amountCents: 8900 })

    // The mapper denies a second payment for the same shop before any human
    // is asked again, so the ledger and Stripe cannot disagree.
    expect(await h.use('pay_service', { shopId: 'nashville-lube', amountCents: 8900 })).toEqual({
      denied: 'Spending gate: SPEND_INPUT_INVALID: ALREADY_PAID',
    })
    // Defense in depth: the handler itself refuses if ever reached directly.
    expect(await h.handlers.pay({ shopId: 'nashville-lube', amountCents: 8900 })).toEqual({
      status: 'refused',
      reason: 'ALREADY_PAID',
    })
    const bookings = h.gate.ledger().filter((e) => e.category === 'service_booking')
    expect(bookings).toHaveLength(1)
  })

  it('a later failed screen invalidates an earlier passed one', async () => {
    const h = harness({
      outcomes: [
        SCREEN,
        { available: true, answers: { manual: false, insurance: true, slot: true } },
      ],
    })
    const first = await h.use('vet_tasker', { taskerId: 'maria-r', slot: 'Tuesday 8:00 AM' })
    expect(first).toMatchObject({ passed: true })
    const second = await h.use('vet_tasker', { taskerId: 'maria-r', slot: 'Tuesday 8:00 AM' })
    expect(second).toMatchObject({ passed: false, failures: ['SCREEN_ANSWER_manual'] })

    expect(await h.use('hire_tasker', { taskerId: 'maria-r' })).toEqual({
      denied: 'Spending gate: SPEND_INPUT_INVALID: NOT_SCREENED',
    })
  })

  it('a later not-booked call invalidates an earlier stored quote', async () => {
    const h = harness({ outcomes: [SERVICE, { booked: false, notes: 'No longer available.' }] })
    const first = await h.use('book_service', { shopId: 'nashville-lube', ...booking })
    expect(first).toMatchObject({ booked: true, quoteCents: 8900 })
    const second = await h.use('book_service', { shopId: 'nashville-lube', ...booking })
    expect(second).toMatchObject({ booked: false })

    expect(await h.use('pay_service', { shopId: 'nashville-lube', amountCents: 8900 })).toEqual({
      denied: 'Spending gate: SPEND_INPUT_INVALID: NO_QUOTE',
    })
  })
})
