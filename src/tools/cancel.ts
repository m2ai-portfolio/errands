import { z } from 'zod'
import { assistantBase, type VoiceConfig } from './phone.js'

export interface CancellationRequest {
  merchant: string
  customerName: string
  amountCents: number
  cadence: string
}

// Mirrors the missing-means-unknown convention from phone.ts: only `cancelled`
// is required, everything else defaults when the call analysis omits it.
export const CancelOutcomeSchema = z.object({
  cancelled: z.boolean(),
  confirmation: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  mustCallYourself: z
    .boolean()
    .nullish()
    .transform((v) => v ?? false),
  effectiveDate: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  notes: z
    .string()
    .nullish()
    .transform((v) => v ?? ''),
})
export type CancelOutcome = z.infer<typeof CancelOutcomeSchema>

const cancelOutcomeJsonSchema = {
  type: 'object',
  properties: {
    cancelled: { type: 'boolean', description: 'True only if the subscription was cancelled.' },
    confirmation: {
      type: ['string', 'null'],
      description: 'Confirmation number given for the cancellation.',
    },
    mustCallYourself: {
      type: 'boolean',
      description: 'True if the business insisted the account holder must call themselves.',
    },
    effectiveDate: {
      type: ['string', 'null'],
      description: 'The date the cancellation takes effect.',
    },
    notes: { type: 'string', description: 'One sentence on anything the customer must know.' },
  },
  required: ['cancelled', 'confirmation', 'mustCallYourself', 'effectiveDate', 'notes'],
}

function formatDollars(amountCents: number): string {
  return `$${(amountCents / 100).toFixed(2)}`
}

export function buildCancellationAssistant(req: CancellationRequest, voice: VoiceConfig) {
  const amount = formatDollars(req.amountCents)
  const system = [
    `You are Errands, an AI assistant calling ${req.merchant} on behalf of ${req.customerName} to cancel their subscription.`,
    'At the very start, say you are an AI assistant calling to cancel a subscription.',
    `State the merchant (${req.merchant}), the amount (${amount}) and the billing cadence (${req.cadence}).`,
    'Ask for a confirmation number and the date the cancellation takes effect.',
    'If the business says the account holder must call themselves, accept that and record it rather than arguing.',
    'Never give out any card, account or personal payment details.',
    'Never accept a retention offer, discount, or pause in place of cancelling.',
    'Before ending, repeat back the confirmation number to make sure it was heard correctly.',
  ].join('\n')
  return assistantBase('Errands cancellation call', system, voice, cancelOutcomeJsonSchema)
}
