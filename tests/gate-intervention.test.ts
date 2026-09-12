import type { BeforeToolCallEvent } from '@strands-agents/sdk'
import { describe, expect, it, vi } from 'vitest'
import { createGate, type Policy, type SpendRequest } from '../src/gate.js'
import {
  SpendingGateIntervention,
  type AskHuman,
  type SpendInputMapper,
} from '../src/gate-intervention.js'
import type { StepUpChannel } from '../src/stepup.js'

const policy: Policy = {
  enabled: true,
  perTransactionCapCents: 10000,
  dailyCapCents: 20000,
  weeklyCapCents: 40000,
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
  categories: { call: 'allow', restaurant_deposit: 'confirm', gift: 'forbid', hire: 'confirm' },
}
const t0 = new Date('2026-09-12T18:00:00Z')

const toRequest: SpendInputMapper = (input) => {
  const i = input as Record<string, unknown>
  if (typeof i.merchant !== 'string' || typeof i.amountCents !== 'number') {
    throw new Error('bad input')
  }
  return { merchant: i.merchant, amountCents: i.amountCents, category: String(i.category) }
}
const spendTools = new Map([['pay_deposit', toRequest]])

function eventFor(name: string, input: unknown): BeforeToolCallEvent {
  return { toolUse: { name, toolUseId: 'tool-1', input } } as unknown as BeforeToolCallEvent
}

const askYes: AskHuman = async () => true
const askNever: AskHuman = async () => false
const stepUpNever: StepUpChannel = async () => {}
const event = eventFor

function setup(answer: boolean, p: Policy = policy) {
  const gate = createGate(p)
  const prompts: string[] = []
  const notes: string[] = []
  const intervention = new SpendingGateIntervention(
    gate,
    spendTools,
    async (prompt) => {
      prompts.push(prompt)
      return answer
    },
    stepUpNever,
    (l) => notes.push(l),
    () => t0,
  )
  return { gate, prompts, notes, intervention }
}

const deposit = { merchant: 'Bella Cucina', amountCents: 1500, category: 'restaurant_deposit' }
const depositEvent = (amountCents: number) => eventFor('pay_deposit', { ...deposit, amountCents })

describe('SpendingGateIntervention', () => {
  it('fails closed if the intervention itself throws', () => {
    expect(setup(true).intervention.onError).toBe('deny')
  })

  it('lets non-spending tools through untouched', async () => {
    const { intervention, prompts } = setup(true)
    const action = await intervention.beforeToolCall(eventFor('search_restaurants', { q: 'x' }))
    expect(action.type).toBe('proceed')
    expect(prompts).toHaveLength(0)
  })

  it('denies a forbidden spend without asking the human', async () => {
    const { intervention, prompts } = setup(true)
    const action = await intervention.beforeToolCall(
      eventFor('pay_deposit', { ...deposit, category: 'gift' }),
    )
    expect(action).toMatchObject({ type: 'deny', reason: 'Spending gate: CATEGORY_FORBIDDEN' })
    expect(prompts).toHaveLength(0)
  })

  it('denies malformed spend input', async () => {
    const action = await setup(true).intervention.beforeToolCall(
      eventFor('pay_deposit', 'fifteen dollars'),
    )
    expect(action).toMatchObject({ type: 'deny', reason: 'Spending gate: SPEND_INPUT_INVALID' })
  })

  it('strips a model-supplied approval code on an allowed spend', async () => {
    const { intervention } = setup(true)
    const event = eventFor('pay_deposit', {
      ...deposit,
      category: 'call',
      amountCents: 0,
      approvalCode: '123456',
    })
    const action = await intervention.beforeToolCall(event)
    expect(action.type).toBe('transform')
    if (action.type === 'transform') action.apply(event)
    expect(event.toolUse.input).not.toHaveProperty('approvalCode')
  })

  it('asks the human once and injects a real approval code when they say yes', async () => {
    const { intervention, prompts, gate } = setup(true)
    const event = eventFor('pay_deposit', { ...deposit, approvalCode: '000000' })
    const action = await intervention.beforeToolCall(event)
    expect(prompts).toEqual([
      'Errands wants to spend $15.00 (restaurant_deposit) at Bella Cucina. Approve?',
    ])
    expect(action.type).toBe('transform')
    if (action.type === 'transform') action.apply(event)
    const input = event.toolUse.input as unknown as SpendRequest & { approvalCode: string }
    expect(input.approvalCode).toMatch(/^\d{6}$/)
    expect(input.approvalCode).not.toBe('000000')
    expect(gate.commit(deposit, t0, input.approvalCode).approvedBy).toBe('human')
  })

  it('denies and records nothing when the human says no', async () => {
    const { intervention, gate } = setup(false)
    const action = await intervention.beforeToolCall(eventFor('pay_deposit', deposit))
    expect(action).toMatchObject({ type: 'deny', reason: 'Spending gate: HUMAN_DECLINED' })
    expect(gate.ledger()).toHaveLength(0)
  })

  it('denies everything when the kill switch is off', async () => {
    const { intervention } = setup(true, { ...policy, enabled: false })
    const action = await intervention.beforeToolCall(
      eventFor('pay_deposit', { ...deposit, category: 'call', amountCents: 0 }),
    )
    expect(action).toMatchObject({ type: 'deny', reason: 'Spending gate: KILL_SWITCH' })
  })

  it('lets a notify decision through with no code and tells the human afterwards', async () => {
    // gate with proven agent in restaurant_deposit: pre-seed three clean events
    const events = [0, 1, 2].map((i) => ({
      counterpartyId: 'agent:restaurant_deposit',
      kind: 'clean' as const,
      detail: 'restaurant_deposit',
      at: new Date(t0.getTime() - (3 - i) * 3600_000).toISOString(),
    }))
    const gate = createGate(policy, [], events)
    const notes: string[] = []
    const intervention = new SpendingGateIntervention(
      gate,
      spendTools,
      askNever,
      stepUpNever,
      (l) => notes.push(l),
      () => t0,
    )
    const action = await intervention.beforeToolCall(depositEvent(1500))
    expect(action.type).toBe('transform')
    expect(notes[0]).toMatch(/track record/i)
  })

  it('delivers the code out of band and requires the human to type it at or above stepUpCents', async () => {
    const delivered: string[] = []
    const stepUp = async (code: string) => {
      delivered.push(code)
    }
    const ask = vi.fn(
      async (_p: string, o?: { expectCode?: string }) => o?.expectCode === delivered[0],
    )
    const gate = createGate(policy)
    const intervention = new SpendingGateIntervention(
      gate,
      spendTools,
      ask,
      stepUp,
      () => {},
      () => t0,
    )
    const action = await intervention.beforeToolCall(depositEvent(5000))
    expect(delivered).toHaveLength(1)
    expect(ask.mock.calls[0]?.[1]).toEqual({ expectCode: delivered[0] })
    expect(action.type).toBe('transform')
  })

  it('denies and records nothing when the human types the wrong step-up code', async () => {
    const delivered: string[] = []
    const stepUp = async (code: string) => {
      delivered.push(code)
    }
    const ask = vi.fn(async (_p: string, o?: { expectCode?: string }) => o?.expectCode === 'wrong')
    const gate = createGate(policy)
    const intervention = new SpendingGateIntervention(
      gate,
      spendTools,
      ask,
      stepUp,
      () => {},
      () => t0,
    )
    const action = await intervention.beforeToolCall(depositEvent(5000))
    expect(action).toMatchObject({ type: 'deny', reason: 'Spending gate: HUMAN_DECLINED' })
    expect(gate.ledger()).toHaveLength(0)
  })

  it('does not deliver a code out of band below stepUpCents', async () => {
    const delivered: string[] = []
    const intervention = new SpendingGateIntervention(
      createGate(policy),
      spendTools,
      askYes,
      async (c) => {
        delivered.push(c)
      },
      () => {},
      () => t0,
    )
    await intervention.beforeToolCall(depositEvent(1500))
    expect(delivered).toHaveLength(0)
  })

  it('includes the mapper evidence in the human prompt', async () => {
    const prompts: string[] = []
    const tools = new Map(spendTools)
    tools.set('hire_tasker', () => ({
      merchant: 'Maria R.',
      amountCents: 3800,
      category: 'hire',
      counterpartyId: 'maria-r',
      handover: true,
      evidence: '4.9 stars, 212 jobs, background checked',
    }))
    const gate = createGate({ ...policy, counterparties: { 'maria-r': { rung: 'trusted' } } })
    const intervention = new SpendingGateIntervention(
      gate,
      tools,
      async (p) => {
        prompts.push(p)
        return true
      },
      stepUpNever,
      () => {},
      () => t0,
    )
    await intervention.beforeToolCall(event('hire_tasker', { taskerId: 'maria-r' }))
    expect(prompts[0]).toContain('4.9 stars, 212 jobs')
  })
})
