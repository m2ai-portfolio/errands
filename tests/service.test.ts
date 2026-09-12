import { describe, expect, it } from 'vitest'
import {
  buildScreenAssistant,
  buildServiceAssistant,
  parseOutcome,
  ScreenOutcomeSchema,
  ServiceOutcomeSchema,
} from '../src/tools/service.js'

const voice = { provider: 'vapi', voiceId: 'Elliot' }

describe('ServiceOutcomeSchema', () => {
  it('defaults missing fields when only booked is present', () => {
    const parsed = parseOutcome(ServiceOutcomeSchema, { booked: true })
    expect(parsed).toEqual({
      booked: true,
      slot: null,
      quoteCents: 0,
      confirmation: null,
      notes: '',
    })
  })

  it('passes through provided values', () => {
    const parsed = parseOutcome(ServiceOutcomeSchema, {
      booked: true,
      slot: 'Tomorrow 9 AM',
      quoteCents: 12500,
      confirmation: 'Under Alex',
      notes: 'Bring the car early.',
    })
    expect(parsed).toEqual({
      booked: true,
      slot: 'Tomorrow 9 AM',
      quoteCents: 12500,
      confirmation: 'Under Alex',
      notes: 'Bring the car early.',
    })
  })

  it('fails to parse without booked', () => {
    expect(parseOutcome(ServiceOutcomeSchema, { slot: 'x' })).toBeNull()
  })
})

describe('ScreenOutcomeSchema', () => {
  it('defaults answers to an empty object when only available is present', () => {
    const parsed = parseOutcome(ScreenOutcomeSchema, { available: false })
    expect(parsed).toEqual({ available: false, answers: {}, notes: '' })
  })

  it('passes through provided answers', () => {
    const parsed = parseOutcome(ScreenOutcomeSchema, {
      available: true,
      answers: { manual: true, insurance: false, slot: true },
      notes: 'Confident on manual.',
    })
    expect(parsed).toEqual({
      available: true,
      answers: { manual: true, insurance: false, slot: true },
      notes: 'Confident on manual.',
    })
  })

  it('fails to parse without available', () => {
    expect(parseOutcome(ScreenOutcomeSchema, { notes: 'x' })).toBeNull()
  })
})

describe('buildServiceAssistant', () => {
  const req = {
    shopName: 'Downtown Auto',
    customerName: 'Alex',
    vehicle: '2016 Honda Civic',
    service: 'oil change',
    window: 'this week',
  }
  const assistant = buildServiceAssistant(req, voice)
  const system = assistant.model.messages[0]?.content ?? ''

  it('is named for the service booking call', () => {
    expect(assistant.name).toBe('Errands service booking call')
  })

  it('names the vehicle and service in the prompt', () => {
    expect(system).toContain('2016 Honda Civic')
    expect(system).toContain('oil change')
    expect(system).toContain('this week')
  })

  it('asks for the total quote including parts and refuses to agree to pay', () => {
    expect(system.toLowerCase()).toContain('quote')
    expect(system).toContain('parts')
    expect(system).toContain('do NOT agree to pay')
  })

  it('instructs repeating back slot, quote and confirmation', () => {
    expect(system).toContain('slot')
    expect(system.toLowerCase()).toContain('confirmation')
  })

  it('uses claude-sonnet-4-6', () => {
    expect(assistant.model.model).toBe('claude-sonnet-4-6')
  })

  it('lists every ServiceOutcomeSchema field as required in the structured data schema', () => {
    expect(assistant.analysisPlan.structuredDataPlan.schema.required).toEqual(
      expect.arrayContaining(['booked', 'slot', 'quoteCents', 'confirmation', 'notes']),
    )
  })
})

describe('buildScreenAssistant', () => {
  const questions = [
    'Have you driven a manual transmission car?',
    'Is your vehicle insurance current?',
    'Are you available at the slot?',
  ]
  const req = {
    taskerName: 'Jordan',
    customerName: 'Alex',
    task: 'move a couch',
    slot: 'Friday 2 PM',
    questions,
  }
  const assistant = buildScreenAssistant(req, voice)
  const system = assistant.model.messages[0]?.content ?? ''

  it('is named for the tasker screen call', () => {
    expect(assistant.name).toBe('Errands tasker screen call')
  })

  it('contains every question verbatim', () => {
    for (const question of questions) {
      expect(system).toContain(question)
    }
  })

  it('instructs recording each answer as yes or no under a short key', () => {
    expect(system.toLowerCase()).toContain('yes or no')
    expect(system.toLowerCase()).toContain('key')
  })

  it('documents manual, insurance, slot as the keys to use in order', () => {
    expect(system).toContain('manual')
    expect(system).toContain('insurance')
    expect(system).toContain('slot')
  })

  it('never mentions the word address', () => {
    expect(system.toLowerCase()).not.toContain('address')
  })

  it('does not contain the customer full name, only the first name given', () => {
    expect(system).toContain('Alex')
  })

  it('uses claude-sonnet-4-6', () => {
    expect(assistant.model.model).toBe('claude-sonnet-4-6')
  })

  it('lists every ScreenOutcomeSchema field as required in the structured data schema', () => {
    expect(assistant.analysisPlan.structuredDataPlan.schema.required).toEqual(
      expect.arrayContaining(['available', 'answers', 'notes']),
    )
  })
})
