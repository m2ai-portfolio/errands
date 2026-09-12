import { z } from 'zod'

import { assistantBase, type VoiceConfig } from './phone.js'

export { parseOutcome } from './phone.js'

// Vapi call scripts for service-shop bookings and tasker phone screens. Same
// pattern as phone.ts's reservation script: assistantBase builds the shared
// Vapi assistant body, each script owns its own system prompt and outcome
// schema.

export interface ServiceRequest {
  shopName: string
  customerName: string
  vehicle: string
  service: string
  window: string
}

// Vapi omits structured-data fields it has no value for, so missing and null
// mean the same thing. Only `booked` is required: without it the outcome is
// genuinely unknown.
export const ServiceOutcomeSchema = z.object({
  booked: z.boolean(),
  slot: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  quoteCents: z
    .number()
    .int()
    .min(0)
    .nullish()
    .transform((v) => v ?? 0),
  confirmation: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  notes: z
    .string()
    .nullish()
    .transform((v) => v ?? ''),
})
export type ServiceOutcome = z.infer<typeof ServiceOutcomeSchema>

const serviceOutcomeJsonSchema = {
  type: 'object',
  properties: {
    booked: { type: 'boolean', description: 'True only if the shop confirmed a booking.' },
    slot: { type: ['string', 'null'], description: 'Confirmed slot, e.g. Tomorrow 9 AM.' },
    quoteCents: {
      type: 'integer',
      description: 'Total quote including parts and labor, in cents. 0 if none was given.',
    },
    confirmation: {
      type: ['string', 'null'],
      description: 'Confirmation number or the name the booking is under.',
    },
    notes: { type: 'string', description: 'One sentence on anything the customer must know.' },
  },
  required: ['booked', 'slot', 'quoteCents', 'confirmation', 'notes'],
}

export function buildServiceAssistant(req: ServiceRequest, voice: VoiceConfig) {
  const system = [
    `You are Errands, an AI assistant phoning ${req.shopName} on behalf of ${req.customerName} to book ${req.service} for their ${req.vehicle}.`,
    'At the very start, say you are an AI assistant calling to book a service appointment.',
    `Ask for the earliest available slot ${req.window}.`,
    'Ask for the total quote for the job, including parts, not just labor.',
    'If they require a deposit or card to hold the slot, ask the amount, say your client will confirm and pay through a link, and do NOT agree to pay.',
    'Never give out any card, account or personal details beyond the name for the booking.',
    'Before ending, repeat back the slot, quote and confirmation number or name. Keep the call under two minutes.',
  ].join('\n')
  return assistantBase('Errands service booking call', system, voice, serviceOutcomeJsonSchema)
}

export interface ScreenRequest {
  taskerName: string
  customerName: string
  task: string
  slot: string
  questions: string[]
}

export const ScreenOutcomeSchema = z.object({
  available: z.boolean(),
  answers: z
    .record(z.string(), z.boolean())
    .nullish()
    .transform((v) => v ?? {}),
  notes: z
    .string()
    .nullish()
    .transform((v) => v ?? ''),
})
export type ScreenOutcome = z.infer<typeof ScreenOutcomeSchema>

const screenOutcomeJsonSchema = {
  type: 'object',
  properties: {
    available: {
      type: 'boolean',
      description: 'True only if the tasker is available and willing to take the job.',
    },
    answers: {
      type: 'object',
      properties: {
        manual: { type: 'boolean', description: 'Comfortable driving a manual transmission.' },
        insurance: { type: 'boolean', description: "Insured to drive a customer's vehicle." },
        slot: { type: 'boolean', description: 'Can make the described drop-off and pick-up slot.' },
      },
      required: ['manual', 'insurance', 'slot'],
      additionalProperties: false,
      description: 'Each screening question answer, under exactly these three keys, true or false.',
    },
    notes: { type: 'string', description: 'One sentence on anything the customer must know.' },
  },
  required: ['available', 'answers', 'notes'],
}

export function buildScreenAssistant(req: ScreenRequest, voice: VoiceConfig) {
  const questionLines = req.questions.map((q) => `- ${q}`).join('\n')
  const system = [
    `You are Errands, an AI assistant phoning ${req.taskerName} on behalf of ${req.customerName} about a job found on a task marketplace.`,
    'At the very start, say you are an AI assistant calling on behalf of a customer about a job posted on a task marketplace.',
    `Describe the task: ${req.task}, at this slot: ${req.slot}.`,
    'Ask each of the following questions, in order, and record each answer as yes or no under a short key:',
    questionLines,
    'Record the answers under exactly these keys: manual (drives a manual transmission), insurance (vehicle insurance current), slot (available at the slot). Use no other keys.',
    "Do not share the customer's home location or any other location details, and do not share the customer's full name, only their first name.",
    'Thank them for their time and end the call politely once every question has been answered.',
  ].join('\n')
  return assistantBase('Errands tasker screen call', system, voice, screenOutcomeJsonSchema)
}
