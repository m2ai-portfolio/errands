import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import type { ErrandsConfig } from '../config.js'
import { GateError, type Gate } from '../gate.js'
import type { SpendInputMapper } from '../gate-intervention.js'
import type { BankSource } from '../tools/bank.js'
import {
  buildCancellationAssistant,
  CancelOutcomeSchema,
  sanitizeForPrompt,
} from '../tools/cancel.js'
import {
  demoLine,
  parseOutcome,
  PhoneError,
  type DestinationPolicy,
  type VoiceConfig,
} from '../tools/phone.js'
import type { RecurringCharge } from '../tools/recurring.js'
import { findRecurring } from '../tools/recurring.js'
import type { CallRunner, ErrandModule, Json } from './types.js'

export const MAX_CANCEL_CALLS_PER_ERRAND = 5

export interface SubscriptionDeps {
  config: Pick<ErrandsConfig, 'mode' | 'demoLinesByRole' | 'liveAllowlist' | 'customerName'>
  gate: Gate
  bank: BankSource
  runCall: CallRunner
  voice: VoiceConfig
  now?: () => Date
  log?: (line: string) => void
  // Where the customer opens the Stripe Financial Connections page. Only used
  // for the one log line that tells them to go there; the CLI supplies it.
  connectUrl?: string
}

const promptLines = [
  '1. Use connect_bank first. It returns the account the customer just linked.',
  '2. Use list_recurring with that account id and show the customer the FULL list, every merchant with its amount and cadence.',
  '3. Ask the customer which of those to cancel, in ONE message, and wait for their answer. Never guess.',
  `4. Cancel with cancel_subscription, one merchant at a time, and only merchants the customer named. At most ${MAX_CANCEL_CALLS_PER_ERRAND} cancellation calls in total.`,
  '5. Finish with what was cancelled, the confirmation numbers, the effective dates, and any subscription the customer must call themselves.',
  'On step 3: if the original request already named what to cancel (for example "cancel Netflix"), skip the question and cancel only those. If it did not name anything (for example "cancel what I do not use"), list the charges, ask the question, and end your turn there.',
]

const formatDollars = (amountCents: number): string => `$${(amountCents / 100).toFixed(2)}`

export function subscriptionsErrand(deps: SubscriptionDeps): ErrandModule & {
  handlers: {
    connect(): Promise<Json>
    listRecurring(input: z.infer<typeof ListInput>): Promise<Json>
    cancel(input: z.infer<typeof CancelInput>): Promise<Json>
  }
} {
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? (() => {})
  // Only merchants that came back from the most recent list_recurring can be
  // cancelled, so the model cannot invent a business to phone.
  const known = new Map<string, RecurringCharge>()
  let callsMade = 0

  const policy: DestinationPolicy =
    deps.config.mode === 'demo'
      ? {
          mode: 'demo',
          lines: deps.config.demoLinesByRole.switchboard
            ? [deps.config.demoLinesByRole.switchboard]
            : [],
        }
      : { mode: 'live', allowlist: deps.config.liveAllowlist }

  const lookup = (merchant: unknown): RecurringCharge | undefined =>
    typeof merchant === 'string' ? known.get(merchant.trim().toLowerCase()) : undefined

  // Run through sanitizeForPrompt even though today's inputs are numeric/date
  // fields, not free text: this string reaches the human approval prompt, and
  // any bank-derived field that lands there gets the same control-char /
  // length guard as the merchant name in cancel.ts.
  const evidenceFor = (charge: RecurringCharge): string =>
    sanitizeForPrompt(
      `${formatDollars(charge.amountCents)} ${charge.cadence}, last charged ${charge.lastChargedAt.slice(0, 10)}`,
    )

  const handlers = {
    async connect(): Promise<Json> {
      if (deps.bank.source === 'stripe' && deps.connectUrl) {
        log(
          `connect bank: open ${deps.connectUrl} on your phone or the Surface and pick the "Test (Non-OAuth)" institution`,
        )
      }
      const account = await deps.bank.connect()
      log(`connected ${account.institution} ****${account.last4}`)
      return { accountId: account.id, institution: account.institution, last4: account.last4 }
    },

    async listRecurring(input: z.infer<typeof ListInput>): Promise<Json> {
      const rows = await deps.bank.transactions(input.accountId)
      const charges = findRecurring(rows, now())
      known.clear()
      for (const charge of charges) known.set(charge.merchant.toLowerCase(), charge)
      for (const charge of charges) {
        log(`${charge.merchant}: ${formatDollars(charge.amountCents)} ${charge.cadence}`)
      }
      return charges.map((charge) => ({
        merchant: charge.merchant,
        amountCents: charge.amountCents,
        cadence: charge.cadence,
        lastChargedAt: charge.lastChargedAt,
        count: charge.count,
      }))
    },

    async cancel(input: z.infer<typeof CancelInput>): Promise<Json> {
      const charge = lookup(input.merchant)
      if (!charge) return { status: 'refused', reason: 'UNKNOWN_MERCHANT' }
      if (callsMade >= MAX_CANCEL_CALLS_PER_ERRAND)
        return { status: 'refused', reason: 'CALL_LIMIT_REACHED' }

      // Resolve the destination FIRST, before either spend is committed. In
      // demo mode every cancellation goes to the switchboard test line; in
      // live mode there is no merchant phone number to dial, so it refuses.
      // Doing this before gate.commit means a refused dial leaves no
      // ledger row and does not consume the human's approval code.
      let to: string
      try {
        to = demoLine(
          policy,
          deps.config.mode === 'demo' ? deps.config.demoLinesByRole.switchboard : null,
        )
      } catch (error) {
        if (error instanceof PhoneError) return { status: 'refused', reason: error.code }
        return { status: 'refused', reason: error instanceof GateError ? error.reason : 'REFUSED' }
      }

      // Point of action for the cancellation itself: a 0-cent confirm, so a human
      // has approved this specific merchant before anything is phoned.
      try {
        deps.gate.commit(
          { merchant: charge.merchant, amountCents: 0, category: 'cancellation' },
          now(),
          input.approvalCode,
        )
      } catch (error) {
        return { status: 'refused', reason: error instanceof GateError ? error.reason : 'REFUSED' }
      }

      // Cancelling is also an outbound phone call, and calls are gated too.
      try {
        deps.gate.commit({ merchant: charge.merchant, amountCents: 0, category: 'call' }, now())
      } catch (error) {
        return { status: 'refused', reason: error instanceof GateError ? error.reason : 'REFUSED' }
      }

      callsMade += 1
      log(
        `calling ${charge.merchant} to cancel (call ${callsMade}${deps.config.mode === 'demo' ? ', demo switchboard' : ''})`,
      )
      const result = await deps.runCall({
        to,
        assistant: buildCancellationAssistant(
          {
            merchant: charge.merchant,
            customerName: deps.config.customerName,
            amountCents: charge.amountCents,
            cadence: charge.cadence,
          },
          deps.voice,
        ),
      })
      const outcome = parseOutcome(CancelOutcomeSchema, result.structuredData)
      log(
        `${charge.merchant}: ${outcome ? (outcome.cancelled ? `cancelled ${outcome.confirmation ?? ''}`.trim() : 'not cancelled') : 'no clear outcome'}`,
      )
      return {
        status: 'completed',
        merchant: charge.merchant,
        cancelled: outcome?.cancelled ?? false,
        confirmation: outcome?.confirmation ?? null,
        effectiveDate: outcome?.effectiveDate ?? null,
        mustCallYourself: outcome?.mustCallYourself ?? false,
        notes: outcome?.notes ?? 'The call ended without a clear answer.',
        summary: result.summary,
      }
    },
  }

  // What the gate sees for cancel_subscription. A merchant that was never listed
  // throws here, so the intervention denies it before any human is asked. The
  // call cap is checked here too, not just in the handler, so a 6th cancel is
  // refused before the human is ever asked to approve it (see handler for the
  // matching point-of-action check).
  const spendTools = new Map<string, SpendInputMapper>([
    [
      'cancel_subscription',
      (input) => {
        if (callsMade >= MAX_CANCEL_CALLS_PER_ERRAND) throw new Error('CALL_LIMIT_REACHED')
        const charge = lookup((input as { merchant?: unknown }).merchant)
        if (!charge) throw new Error('UNKNOWN_MERCHANT')
        return {
          merchant: charge.merchant,
          amountCents: 0,
          category: 'cancellation',
          evidence: evidenceFor(charge),
          triedFirst: 'listed your recurring charges from the connected account',
        }
      },
    ],
  ])

  const tools = [
    tool({
      name: 'connect_bank',
      description:
        'Link the customer bank account that will be scanned for subscriptions. Returns the account id to use with list_recurring.',
      inputSchema: ConnectInput,
      callback: () => handlers.connect(),
    }),
    tool({
      name: 'list_recurring',
      description:
        'List the recurring charges on a connected account, with the amount, cadence and last charge date for each.',
      inputSchema: ListInput,
      callback: (input) => handlers.listRecurring(input),
    }),
    tool({
      name: 'cancel_subscription',
      description:
        'Phone one merchant (an AI voice call) to cancel a listed subscription. A human approves every cancellation.',
      inputSchema: CancelInput,
      callback: (input) => handlers.cancel(input),
    }),
  ]

  return { name: 'subscriptions', tools, spendTools, promptLines, handlers }
}

const ConnectInput = z.object({})

const ListInput = z.object({
  accountId: z.string().describe('An account id returned by connect_bank'),
})

const CancelInput = z.object({
  merchant: z.string().describe('A merchant name exactly as returned by list_recurring'),
  approvalCode: z.string().optional().describe('Leave empty. Filled in by the approval system.'),
})
