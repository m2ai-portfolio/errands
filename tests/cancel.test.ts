import { describe, expect, it } from 'vitest'
import { parseOutcome } from '../src/tools/phone.js'
import { buildCancellationAssistant, CancelOutcomeSchema } from '../src/tools/cancel.js'

describe('CancelOutcomeSchema', () => {
  it('defaults missing confirmation, effectiveDate, mustCallYourself and notes', () => {
    const parsed = parseOutcome(CancelOutcomeSchema, { cancelled: true })
    expect(parsed).toEqual({
      cancelled: true,
      confirmation: null,
      mustCallYourself: false,
      effectiveDate: null,
      notes: '',
    })
  })

  it('rejects a payload without cancelled', () => {
    expect(parseOutcome(CancelOutcomeSchema, { confirmation: 'ABC123' })).toBeNull()
  })
})

describe('buildCancellationAssistant', () => {
  const req = {
    merchant: 'Streamly',
    customerName: 'Alex',
    amountCents: 1549,
    cadence: 'monthly',
  }
  const assistant = buildCancellationAssistant(req, { provider: 'vapi', voiceId: 'Elliot' }) as {
    name: string
    model: { model: string; provider: string; messages: { content: string }[] }
    analysisPlan: { structuredDataPlan: { schema: { required: string[] } } }
  }
  const system = assistant.model.messages[0]?.content ?? ''

  it('names the merchant, the amount as $15.49, and identifies as an AI assistant calling to cancel', () => {
    expect(system).toContain('Streamly')
    expect(system).toContain('$15.49')
    expect(system).toContain('AI assistant')
    expect(system).toContain('cancel')
  })

  it('mentions the retention offer refusal and confirmation repeat-back', () => {
    expect(system.toLowerCase()).toContain('retention offer')
    expect(system).toContain('confirmation')
  })

  it('inherits the shared assistant shape, including model, from assistantBase', () => {
    expect(assistant.name).toBe('Errands cancellation call')
    expect(assistant.model.model).toBe('claude-sonnet-4-6')
    expect(assistant.model.provider).toBe('anthropic')
    expect(assistant.analysisPlan.structuredDataPlan.schema.required).toEqual([
      'cancelled',
      'confirmation',
      'mustCallYourself',
      'effectiveDate',
      'notes',
    ])
  })
})
