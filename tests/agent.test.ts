import { describe, expect, it } from 'vitest'
import { mergeSpendTools, systemPrompt } from '../src/agent.js'
import { dinnerErrand } from '../src/errands/dinner.js'
import { createGate, type Policy } from '../src/gate.js'
import { FixtureRestaurantSearch, type Restaurant } from '../src/tools/restaurants.js'
import fixtures from '../fixtures/restaurants.json' with { type: 'json' }

const policy: Policy = {
  enabled: true,
  perTransactionCapCents: 2000,
  dailyCapCents: 2500,
  weeklyCapCents: 4000,
  approvalTtlMinutes: 30,
  stepUpCents: 5000,
  promoteAfter: 3,
  promoteHumanAfter: 1,
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

function buildDinner() {
  return dinnerErrand({
    config: {
      mode: 'demo',
      demoLines: ['+15025550100', '+15025550101'],
      liveAllowlist: [],
      customerName: 'Alex',
    },
    gate: createGate(policy),
    search: new FixtureRestaurantSearch(fixtures as Restaurant[]),
    runCall: async () => ({
      callId: 'c1',
      endedReason: 'assistant-ended-call',
      summary: null,
      structuredData: null,
    }),
    deposits: {
      charge: async (c) => ({ id: 'pi_test', status: 'succeeded', amountCents: c.amountCents }),
    },
    voice: { provider: 'cartesia', voiceId: 'v1' },
  })
}

describe('systemPrompt composition', () => {
  it('merges module prompt lines and the call limit under the errand heading', () => {
    const dinner = buildDinner()
    const prompt = systemPrompt('Alex', [dinner])
    expect(prompt).toContain('Errand "dinner":')
    expect(prompt).toContain('You may make at most 3 calls in total.')
  })
})

describe('mergeSpendTools', () => {
  it('combines every module spend tool into one map', () => {
    const dinner = buildDinner()
    const merged = mergeSpendTools([dinner])
    expect(merged.has('pay_deposit')).toBe(true)
    expect(merged.has('call_restaurant')).toBe(true)
  })
})
