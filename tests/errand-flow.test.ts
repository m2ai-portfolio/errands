import type { BeforeToolCallEvent } from '@strands-agents/sdk'
import { describe, expect, it } from 'vitest'
import { createErrandTools, type CallRunner } from '../src/agent.js'
import { createGate, type Policy } from '../src/gate.js'
import type { DepositCharge } from '../src/tools/deposit.js'
import type { CallOutcome } from '../src/tools/phone.js'
import { FixtureRestaurantSearch, type Restaurant } from '../src/tools/restaurants.js'
import fixtures from '../fixtures/restaurants.json' with { type: 'json' }

// Offline end-to-end run of the hero errand. It follows exactly the order the
// Strands agent loop uses for each tool call: intervention first, then (if it
// allowed or transformed the call) the tool itself.

const policy: Policy = {
  enabled: true,
  perTransactionCapCents: 2000,
  dailyCapCents: 2500,
  weeklyCapCents: 4000,
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
  categories: { call: 'allow', restaurant_deposit: 'confirm', gift: 'forbid' },
}

const FULL: CallOutcome = {
  booked: false,
  confirmedTime: null,
  confirmationCode: null,
  depositRequiredCents: 0,
  notes: 'Fully booked tonight.',
}
const BOOKED: CallOutcome = {
  booked: true,
  confirmedTime: '7:00 PM',
  confirmationCode: 'TR-4821',
  depositRequiredCents: 1500,
  notes: 'Deposit link will be texted.',
}

function harness(opts: { approve: boolean; policy?: Policy }) {
  const dialed: string[] = []
  const charges: DepositCharge[] = []
  const prompts: string[] = []
  const outcomes = [FULL, BOOKED]
  const runCall: CallRunner = async ({ to }) => {
    dialed.push(to)
    return {
      callId: `c${dialed.length}`,
      endedReason: 'assistant-ended-call',
      summary: null,
      structuredData: outcomes[dialed.length - 1] ?? FULL,
    }
  }
  const gate = createGate(opts.policy ?? policy)
  const errand = createErrandTools({
    config: {
      mode: 'demo',
      demoLines: ['+15025550100', '+15025550101'],
      liveAllowlist: [],
      customerName: 'Alex',
    },
    gate,
    search: new FixtureRestaurantSearch(fixtures as Restaurant[]),
    runCall,
    deposits: {
      charge: async (c) => (
        charges.push(c),
        { id: 'pi_test', status: 'succeeded', amountCents: c.amountCents }
      ),
    },
    askHuman: async (p) => (prompts.push(p), opts.approve),
    stepUp: async () => {},
    now: () => new Date('2026-09-12T23:00:00Z'),
    errandId: 'errand-test',
  })

  // One tool call, the way the Strands loop runs it.
  async function use(
    name: 'search_restaurants' | 'call_restaurant' | 'pay_deposit',
    input: Record<string, unknown>,
  ) {
    const event = {
      toolUse: { name, toolUseId: `${name}-${Math.random()}`, input },
    } as unknown as BeforeToolCallEvent
    const action = await errand.intervention.beforeToolCall(event)
    if (action.type === 'deny') return { denied: action.reason }
    if (action.type === 'transform') action.apply(event)
    const finalInput = event.toolUse.input as never
    if (name === 'search_restaurants') return errand.handlers.search(finalInput)
    if (name === 'call_restaurant') return errand.handlers.call(finalInput)
    return errand.handlers.deposit(finalInput)
  }

  return { use, dialed, charges, prompts, gate }
}

const reservation = { partySize: 2, time: '7:00 PM tonight', flexibility: '6:30 to 8:00 PM' }

describe('hero errand: dinner with a fallback', () => {
  it('tries the named restaurant, falls back, and asks the human exactly once for the deposit', async () => {
    const h = harness({ approve: true })
    const first = (await h.use('search_restaurants', { query: 'Bella Cucina' })) as { id: string }[]
    expect(first[0]?.id).toBe('fixture-bella-cucina')

    const call1 = await h.use('call_restaurant', {
      restaurantId: 'fixture-bella-cucina',
      ...reservation,
    })
    expect(call1).toMatchObject({ status: 'completed', booked: false })

    const second = (await h.use('search_restaurants', {
      query: 'italian',
      excludeIds: ['fixture-bella-cucina'],
    })) as { id: string }[]
    expect(second.map((r) => r.id)).toEqual(['fixture-trattoria-roma'])

    const call2 = await h.use('call_restaurant', {
      restaurantId: 'fixture-trattoria-roma',
      ...reservation,
    })
    expect(call2).toMatchObject({
      booked: true,
      confirmationCode: 'TR-4821',
      depositRequiredCents: 1500,
    })

    const paid = await h.use('pay_deposit', {
      restaurantId: 'fixture-trattoria-roma',
      amountCents: 1500,
    })
    expect(paid).toMatchObject({ status: 'paid', amountCents: 1500, testMode: true })

    expect(h.dialed).toEqual(['+15025550100', '+15025550101'])
    expect(h.prompts).toEqual([
      'Errands wants to spend $15.00 (restaurant_deposit) at Trattoria Roma. Approve?',
    ])
    expect(h.charges).toEqual([
      {
        amountCents: 1500,
        description: 'Errands deposit: Trattoria Roma',
        idempotencyKey: 'errand-test-fixture-trattoria-roma-deposit',
      },
    ])
    expect(h.gate.ledger().map((e) => `${e.category}:${e.approvedBy}`)).toEqual([
      'call:policy',
      'call:policy',
      'restaurant_deposit:human',
    ])
  })

  it('never pays when the human declines', async () => {
    const h = harness({ approve: false })
    await h.use('search_restaurants', { query: 'italian' })
    await h.use('call_restaurant', { restaurantId: 'fixture-bella-cucina', ...reservation })
    await h.use('call_restaurant', { restaurantId: 'fixture-trattoria-roma', ...reservation })
    const paid = await h.use('pay_deposit', {
      restaurantId: 'fixture-trattoria-roma',
      amountCents: 1500,
    })
    expect(paid).toEqual({ denied: 'Spending gate: HUMAN_DECLINED' })
    expect(h.charges).toHaveLength(0)
  })

  it('refuses an amount the restaurant never quoted, without bothering the human', async () => {
    const h = harness({ approve: true })
    await h.use('search_restaurants', { query: 'italian' })
    await h.use('call_restaurant', { restaurantId: 'fixture-bella-cucina', ...reservation })
    await h.use('call_restaurant', { restaurantId: 'fixture-trattoria-roma', ...reservation })
    expect(
      await h.use('pay_deposit', { restaurantId: 'fixture-trattoria-roma', amountCents: 1000 }),
    ).toEqual({ denied: 'Spending gate: SPEND_INPUT_INVALID' })
    expect(
      await h.use('pay_deposit', { restaurantId: 'fixture-bella-cucina', amountCents: 1500 }),
    ).toEqual({ denied: 'Spending gate: SPEND_INPUT_INVALID' })
    expect(h.prompts).toHaveLength(0)
  })

  it('cannot call a restaurant it never found, and stops after three calls', async () => {
    const h = harness({ approve: true })
    expect(await h.use('call_restaurant', { restaurantId: 'made-up', ...reservation })).toEqual({
      denied: 'Spending gate: SPEND_INPUT_INVALID',
    })
    await h.use('search_restaurants', { query: 'restaurant italian mexican' })
    for (const id of ['fixture-bella-cucina', 'fixture-trattoria-roma', 'fixture-taco-town']) {
      await h.use('call_restaurant', { restaurantId: id, ...reservation })
    }
    expect(
      await h.use('call_restaurant', { restaurantId: 'fixture-bella-cucina', ...reservation }),
    ).toEqual({ status: 'refused', reason: 'CALL_LIMIT_REACHED' })
    expect(h.dialed).toHaveLength(3)
  })

  it('makes no calls at all when the kill switch is off', async () => {
    const h = harness({ approve: true, policy: { ...policy, enabled: false } })
    await h.use('search_restaurants', { query: 'italian' })
    expect(
      await h.use('call_restaurant', { restaurantId: 'fixture-bella-cucina', ...reservation }),
    ).toEqual({ denied: 'Spending gate: KILL_SWITCH' })
    expect(h.dialed).toHaveLength(0)
  })
})
