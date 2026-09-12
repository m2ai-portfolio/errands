import { describe, expect, it } from 'vitest'
import {
  buildReservationAssistant,
  PhoneError,
  placeCall,
  resolveDestination,
  toE164,
  VAPI_BASE,
  VapiClient,
} from '../src/tools/phone.js'

const demo = { mode: 'demo' as const, lines: ['+16155550001', '+16155550002'] }

describe('resolveDestination', () => {
  it('routes the first attempt to the first demo line and the fallback to the second', () => {
    expect(resolveDestination('(615) 867-5309', 0, demo)).toBe('+16155550001')
    expect(resolveDestination('(615) 867-5309', 1, demo)).toBe('+16155550002')
    expect(resolveDestination(null, 5, demo)).toBe('+16155550002')
  })

  it('never dials a real restaurant in live mode unless it is allowlisted', () => {
    const live = { mode: 'live' as const, allowlist: ['+16158675309'] }
    expect(resolveDestination('(615) 867-5309', 0, live)).toBe('+16158675309')
    expect(() => resolveDestination('(615) 555-1234', 0, live)).toThrow(PhoneError)
    expect(() => resolveDestination(null, 0, live)).toThrow('NO_VALID_NUMBER')
  })

  it('normalizes US numbers to E.164', () => {
    expect(toE164('615-867-5309')).toBe('+16158675309')
    expect(toE164('1 (615) 867 5309')).toBe('+16158675309')
    expect(toE164('12345')).toBeNull()
  })
})

describe('buildReservationAssistant', () => {
  const assistant = buildReservationAssistant(
    {
      restaurantName: 'Bella Cucina',
      customerName: 'Alex',
      partySize: 2,
      time: '7:00 PM tonight',
      flexibility: '6:30 to 8:00 PM',
    },
    { provider: 'vapi', voiceId: 'Elliot' },
  )
  const system = assistant.model.messages[0]?.content ?? ''

  it('discloses that it is an AI and refuses to agree to pay on the call', () => {
    expect(system).toContain('say you are an AI assistant')
    expect(system).toContain('do NOT agree to pay')
    expect(system).toContain('table for 2 at 7:00 PM tonight')
  })

  it('waits for the restaurant to answer and caps call length', () => {
    expect(assistant.firstMessageMode).toBe('assistant-waits-for-user')
    expect(assistant.maxDurationSeconds).toBeLessThanOrEqual(300)
    expect(assistant.analysisPlan.structuredDataPlan.schema.required).toContain('booked')
  })
})

describe('placeCall', () => {
  function fakeVapi(statuses: string[], structuredData: unknown) {
    const requests: { url: string; init: RequestInit }[] = []
    let polls = 0
    const client = new VapiClient('vapi-key', async (url, init) => {
      requests.push({ url, init })
      if (init.method === 'POST') return new Response(JSON.stringify({ id: 'call-1' }))
      const status = statuses[Math.min(polls++, statuses.length - 1)]
      return new Response(
        JSON.stringify({
          id: 'call-1',
          status,
          endedReason: 'assistant-ended-call',
          analysis: { summary: 'Fully booked.', structuredData },
        }),
      )
    })
    return { client, requests }
  }

  const noSleep = async () => {}

  it('creates the call, polls until it ends, and returns the parsed outcome', async () => {
    const outcome = {
      booked: false,
      confirmedTime: null,
      confirmationCode: null,
      depositRequiredCents: 0,
      notes: 'Fully booked until 9:30 PM.',
    }
    const { client, requests } = fakeVapi(['queued', 'in-progress', 'ended'], outcome)
    const result = await placeCall({
      client,
      phoneNumberId: 'pn-1',
      to: '+16155550001',
      assistant: { name: 'x' },
      sleep: noSleep,
    })
    expect(result).toEqual({
      callId: 'call-1',
      endedReason: 'assistant-ended-call',
      summary: 'Fully booked.',
      outcome,
    })
    expect(requests[0]?.url).toBe(`${VAPI_BASE}/call`)
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      phoneNumberId: 'pn-1',
      customer: { number: '+16155550001' },
      assistant: { name: 'x' },
    })
    expect((requests[0]?.init.headers as Record<string, string>).Authorization).toBe(
      'Bearer vapi-key',
    )
    expect(requests).toHaveLength(4)
  })

  it('accepts the real Vapi shape, which omits fields that have no value', async () => {
    // Recorded from live call 01a092eb on 2026-09-11 against the demo "full" line.
    const notes =
      'The restaurant is fully booked tonight and could not accommodate the reservation.'
    const { client } = fakeVapi(['ended'], { notes, booked: false, depositRequiredCents: 0 })
    const result = await placeCall({
      client,
      phoneNumberId: 'pn-1',
      to: '+1',
      assistant: {},
      sleep: noSleep,
    })
    expect(result.outcome).toEqual({
      booked: false,
      confirmedTime: null,
      confirmationCode: null,
      depositRequiredCents: 0,
      notes,
    })
  })

  it('returns a null outcome when the call analysis is malformed', async () => {
    const { client } = fakeVapi(['ended'], { booked: 'maybe' })
    const result = await placeCall({
      client,
      phoneNumberId: 'pn-1',
      to: '+1',
      assistant: {},
      sleep: noSleep,
    })
    expect(result.outcome).toBeNull()
  })

  it('gives up after the timeout instead of waiting forever', async () => {
    const { client } = fakeVapi(['in-progress'], null)
    await expect(
      placeCall({
        client,
        phoneNumberId: 'pn-1',
        to: '+1',
        assistant: {},
        sleep: noSleep,
        pollMs: 10,
        timeoutMs: 30,
      }),
    ).rejects.toThrow('CALL_TIMEOUT')
  })
})
