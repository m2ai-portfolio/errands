import { readFileSync } from 'node:fs'
import type { BeforeToolCallEvent } from '@strands-agents/sdk'
import { describe, expect, it } from 'vitest'
import { subscriptionsErrand } from '../src/errands/subscriptions.js'
import type { CallRunner } from '../src/errands/types.js'
import { createGate, type Policy } from '../src/gate.js'
import { SpendingGateIntervention } from '../src/gate-intervention.js'
import { FixtureBank } from '../src/tools/bank.js'
import type { Transaction } from '../src/tools/recurring.js'

// Offline end-to-end run of the subscription errand, in exactly the order the
// Strands agent loop uses for each tool call: intervention first, then (if it
// allowed or transformed the call) the tool itself. No network, no Vapi, no Stripe.

// The shipped policy, not a test-only one: cancellation must be a confirm category
// in the file the product actually runs on.
const policy = JSON.parse(
  readFileSync(new URL('../policy.json', import.meta.url), 'utf8'),
) as Policy

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/transactions.json', import.meta.url), 'utf8'),
) as Transaction[]

const NOW = new Date('2026-09-11T12:00:00Z')
const SWITCHBOARD = '+15025550102'

const CANCELLED = { cancelled: true, confirmation: 'CX-1' }

function harness(opts: { approve?: boolean; switchboard?: string | null } = {}) {
  const dialed: string[] = []
  const prompts: string[] = []
  const logs: string[] = []
  const runCall: CallRunner = async ({ to }) => {
    dialed.push(to)
    return {
      callId: `c${dialed.length}`,
      endedReason: 'assistant-ended-call',
      summary: 'Cancelled on the first try.',
      structuredData: CANCELLED,
    }
  }
  const gate = createGate(policy)
  const askHuman = async (p: string) => (prompts.push(p), opts.approve ?? true)
  const errand = subscriptionsErrand({
    config: {
      mode: 'demo',
      demoLinesByRole: {
        full: '+15025550100',
        open: '+15025550101',
        switchboard: opts.switchboard === undefined ? SWITCHBOARD : opts.switchboard,
      },
      liveAllowlist: [],
      customerName: 'Alex',
    },
    gate,
    bank: new FixtureBank(fixture),
    runCall,
    voice: { provider: 'cartesia', voiceId: 'v1' },
    now: () => NOW,
    log: (line) => logs.push(line),
  })
  const intervention = new SpendingGateIntervention(
    gate,
    errand.spendTools,
    askHuman,
    async () => {},
    () => {},
    () => NOW,
  )

  // One tool call, the way the Strands loop runs it.
  async function use(
    name: 'connect_bank' | 'list_recurring' | 'cancel_subscription',
    input: Record<string, unknown> = {},
  ) {
    const event = {
      toolUse: { name, toolUseId: `${name}-${Math.random()}`, input },
    } as unknown as BeforeToolCallEvent
    const action = await intervention.beforeToolCall(event)
    if (action.type === 'deny') return { denied: action.reason }
    if (action.type === 'transform') action.apply(event)
    const finalInput = event.toolUse.input as never
    if (name === 'connect_bank') return errand.handlers.connect()
    if (name === 'list_recurring') return errand.handlers.listRecurring(finalInput)
    return errand.handlers.cancel(finalInput)
  }

  const approvalFor = (merchant: string) =>
    gate.requestApproval({ merchant, amountCents: 0, category: 'cancellation' }, NOW).code

  return { use, errand, gate, dialed, prompts, logs, approvalFor }
}

describe('subscription errand: connect, list, cancel', () => {
  it('connects the account and lists the five recurring charges', async () => {
    const h = harness()
    expect(await h.use('connect_bank')).toEqual({
      accountId: 'fixture-checking',
      institution: 'Demo Bank',
      last4: '0000',
    })
    const rows = (await h.use('list_recurring', { accountId: 'fixture-checking' })) as {
      merchant: string
      amountCents: number
      cadence: string
      lastChargedAt: string
      count: number
    }[]
    expect(rows.map((r) => r.merchant).sort()).toEqual([
      'Clouddrive Plus',
      'Coffee Club',
      'Netflix',
      'Planet Fitness',
      'Spotify',
    ])
    const netflix = rows.find((r) => r.merchant === 'Netflix')
    expect(netflix).toMatchObject({ amountCents: 1549, cadence: 'monthly', count: 6 })
    expect(typeof netflix?.lastChargedAt).toBe('string')
  })

  it('cancels a named subscription through the human approval path', async () => {
    const h = harness({ approve: true })
    await h.use('connect_bank')
    await h.use('list_recurring', { accountId: 'fixture-checking' })
    const result = await h.use('cancel_subscription', { merchant: 'Netflix' })
    expect(result).toMatchObject({
      status: 'completed',
      merchant: 'Netflix',
      cancelled: true,
      confirmation: 'CX-1',
      mustCallYourself: false,
    })
    expect(h.dialed).toEqual([SWITCHBOARD])
    expect(h.prompts).toEqual([
      'Errands wants to spend $0.00 (cancellation) at Netflix. $15.49 monthly, last charged 2026-08-16. Approve?',
    ])
    expect(h.gate.ledger().map((e) => `${e.category}:${e.approvedBy}`)).toEqual([
      'cancellation:human',
      'call:policy',
    ])
    expect(h.gate.ledger().every((e) => e.counterpartyId === undefined)).toBe(true)
  })

  it('refuses to cancel without an approval code, and succeeds with one', async () => {
    const h = harness()
    await h.errand.handlers.connect()
    await h.errand.handlers.listRecurring({ accountId: 'fixture-checking' })

    expect(await h.errand.handlers.cancel({ merchant: 'Netflix' })).toEqual({
      status: 'refused',
      reason: 'APPROVAL_REQUIRED',
    })
    expect(h.dialed).toHaveLength(0)
    expect(h.gate.ledger()).toHaveLength(0)

    const result = await h.errand.handlers.cancel({
      merchant: 'Netflix',
      approvalCode: h.approvalFor('Netflix'),
    })
    expect(result).toMatchObject({ status: 'completed', cancelled: true, confirmation: 'CX-1' })
    const cancellation = h.gate.ledger().find((e) => e.category === 'cancellation')
    expect(cancellation).toMatchObject({
      merchant: 'Netflix',
      amountCents: 0,
      approvedBy: 'human',
    })
  })

  it('refuses a merchant that was never listed, without bothering the human', async () => {
    const h = harness()
    await h.use('connect_bank')
    await h.use('list_recurring', { accountId: 'fixture-checking' })

    expect(await h.use('cancel_subscription', { merchant: 'Hulu' })).toEqual({
      denied: 'Spending gate: SPEND_INPUT_INVALID: UNKNOWN_MERCHANT',
    })
    expect(
      await h.errand.handlers.cancel({ merchant: 'Hulu', approvalCode: h.approvalFor('Netflix') }),
    ).toEqual({ status: 'refused', reason: 'UNKNOWN_MERCHANT' })
    expect(h.prompts).toHaveLength(0)
    expect(h.dialed).toHaveLength(0)
  })

  it('stops after five cancellation calls', async () => {
    const h = harness()
    await h.errand.handlers.connect()
    const rows = (await h.errand.handlers.listRecurring({
      accountId: 'fixture-checking',
    })) as { merchant: string }[]
    expect(rows).toHaveLength(5)
    for (const row of rows) {
      const outcome = await h.errand.handlers.cancel({
        merchant: row.merchant,
        approvalCode: h.approvalFor(row.merchant),
      })
      expect(outcome).toMatchObject({ status: 'completed' })
    }
    expect(h.dialed).toHaveLength(5)

    expect(
      await h.errand.handlers.cancel({
        merchant: 'Netflix',
        approvalCode: h.approvalFor('Netflix'),
      }),
    ).toEqual({ status: 'refused', reason: 'CALL_LIMIT_REACHED' })
    expect(h.dialed).toHaveLength(5)
  })

  it('the mapper also enforces the call cap, so a 6th cancel never wakes the human', async () => {
    const h = harness()
    await h.use('connect_bank')
    const rows = (await h.use('list_recurring', {
      accountId: 'fixture-checking',
    })) as { merchant: string }[]
    for (const row of rows) {
      const result = await h.use('cancel_subscription', { merchant: row.merchant })
      expect(result).toMatchObject({ status: 'completed' })
    }
    expect(h.dialed).toHaveLength(5)
    const promptsBefore = h.prompts.length

    // The 6th call goes through the full intervention path (mapper first),
    // the same as the model would trigger it.
    expect(await h.use('cancel_subscription', { merchant: 'Netflix' })).toEqual({
      denied: 'Spending gate: SPEND_INPUT_INVALID: CALL_LIMIT_REACHED',
    })
    expect(h.dialed).toHaveLength(5)
    // No new approval prompt: the mapper refused before the human was asked.
    expect(h.prompts).toHaveLength(promptsBefore)
  })

  it('a refused dial (no demo lines) leaves no cancellation ledger row and does not burn the approval code', async () => {
    const h = harness({ switchboard: null })
    await h.errand.handlers.connect()
    await h.errand.handlers.listRecurring({ accountId: 'fixture-checking' })
    const code = h.approvalFor('Netflix')

    expect(await h.errand.handlers.cancel({ merchant: 'Netflix', approvalCode: code })).toEqual({
      status: 'refused',
      reason: 'NO_DEMO_LINES',
    })
    expect(h.dialed).toHaveLength(0)
    expect(h.gate.ledger().find((e) => e.category === 'cancellation')).toBeUndefined()
    expect(h.gate.ledger()).toHaveLength(0)
  })
})
