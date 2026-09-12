import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import type { ErrandsConfig } from '../config.js'
import { GateError, type Gate, type SpendRequest } from '../gate.js'
import type { SpendInputMapper } from '../gate-intervention.js'
import type { DepositProcessor } from '../tools/deposit.js'
import { demoLine, PhoneError, type DestinationPolicy, type VoiceConfig } from '../tools/phone.js'
import {
  buildScreenAssistant,
  buildServiceAssistant,
  parseOutcome,
  ScreenOutcomeSchema,
  ServiceOutcomeSchema,
} from '../tools/service.js'
import { scoreTasker, type TaskerSearch } from '../tools/taskers.js'
import { vet, type TaskerProfile, type VettingPolicy } from '../trust.js'
import type { CallRunner, ErrandModule, Json } from './types.js'

// Errand "blurr": get the car serviced while the customer is at work. It books
// and pays a shop, then hires a human from a task marketplace to drive the car
// to and from the shop. The hire is the part that matters: a human who will
// hold the customer's keys is vetted on paper, screened by phone, and only then
// put in front of the human owner for a first-handover approval.

// The call budget below is a per-module-instance counter, not per-errand-name:
// one CLI process is expected to construct and run exactly one errand module
// before exiting, so a single shared counter is correct and there is no need
// to key it by errand id.
export const MAX_CALLS_PER_ERRAND = 3

// The task class every Blurr hire is vetted against.
const TASK_CLASS = 'vehicle'

const SCREEN_TASK = 'drive the car to and from an oil change'

// Asked in this order; the call script records each answer under these keys.
const SCREEN_QUESTIONS = [
  'Are you comfortable driving a car with a manual transmission?',
  "Are you insured to drive a customer's vehicle?",
  'Can you make the slot we just described, both the drop off and the pick up?',
]
const SCREEN_KEYS = ['manual', 'insurance', 'slot'] as const

// The screen call's structured extraction does not always come back keyed
// exactly `manual` / `insurance` / `slot`, even though the prompt asks for
// those keys: a live Vapi call for this same screen once returned
// `available_this_week` / `manual_transmission` / `insured_to_drive_customer_vehicle`,
// and reading those as three missing keys failed a tasker who answered yes to
// everything. An exact key always wins; otherwise fall back to any key whose
// name plausibly means the same thing. A key that matches nothing is still a
// missing answer, not a guessed true.
const SCREEN_KEY_HINTS: Readonly<Record<(typeof SCREEN_KEYS)[number], readonly string[]>> = {
  manual: ['manual'],
  insurance: ['insur'],
  slot: ['slot', 'avail'],
}

function resolveScreenAnswer(
  answers: Record<string, boolean>,
  key: (typeof SCREEN_KEYS)[number],
): boolean {
  if (key in answers) return answers[key] === true
  const hints = SCREEN_KEY_HINTS[key]
  for (const [candidateKey, value] of Object.entries(answers)) {
    const lower = candidateKey.toLowerCase()
    if (hints.some((hint) => lower.includes(hint))) return value === true
  }
  return false
}

export interface Shop {
  id: string
  name: string
  phone: string | null
  address: string
  services: string[]
}

export interface BlurrDeps {
  config: Pick<ErrandsConfig, 'mode' | 'demoLinesByRole' | 'liveAllowlist' | 'customerName'>
  gate: Gate
  taskers: TaskerSearch
  shops: readonly Shop[]
  runCall: CallRunner
  deposits: DepositProcessor
  voice: VoiceConfig
  vetting: VettingPolicy
  now?: () => Date
  log?: (line: string) => void
  errandId?: string
  // Call budget for this module instance. Defaults to the shipped cap; nothing
  // in src/ overrides it, it exists so a test can book a shop AND run several
  // screens inside one harness.
  maxCalls?: number
}

const promptLines = [
  '1. Use find_shops for the service the customer needs, then book_service with the first shop on the list.',
  '2. If that call comes back with a quote, call pay_service with that shop id and exactly the amount it quoted. Never invent or round amounts. Leave approvalCode empty: the approval system fills it in after the human decides.',
  '3. Use find_taskers for the task class "vehicle" to see who could drive the car. Do this only after a shop has booked a slot: vet_tasker screens the driver against the slot the shop agreed to, and is refused with NO_BOOKING_YET before that.',
  `4. Call vet_tasker on candidates in the order returned until one passes. You may make at most ${MAX_CALLS_PER_ERRAND} calls in total across book_service and vet_tasker.`,
  '5. Call hire_tasker only for the tasker whose screen passed. An unscreened person can never be hired.',
  '6. Finish with the slot, the shop confirmation, who is driving the car, what it cost, and how to cancel both the appointment and the driver.',
]

export function blurrErrand(deps: BlurrDeps): ErrandModule & {
  handlers: {
    findShops(input: z.infer<typeof FindShopsInput>): Promise<Json>
    book(input: z.infer<typeof BookInput>): Promise<Json>
    pay(input: z.infer<typeof PayInput>): Promise<Json>
    findTaskers(input: z.infer<typeof FindTaskersInput>): Promise<Json>
    vet(input: z.infer<typeof VetInput>): Promise<Json>
    hire(input: z.infer<typeof HireInput>): Promise<Json>
  }
} {
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? (() => {})
  const errandId = deps.errandId ?? `errand-${Date.now()}`
  const bookings = new Map<string, { quoteCents: number; slot: string | null }>()
  const screens = new Map<string, { slot: string }>()
  const paidShops = new Set<string>()
  const screenedRecorded = new Set<string>()
  const maxCalls = deps.maxCalls ?? MAX_CALLS_PER_ERRAND
  let callsMade = 0
  // The slot the shop actually agreed to, from the most recent booked call.
  // This, not the model's free-text `slot`, is what a driver is screened
  // against and what the hire is recorded for.
  let bookedSlot: string | null = null

  const policy: DestinationPolicy =
    deps.config.mode === 'demo'
      ? {
          mode: 'demo',
          lines: deps.config.demoLinesByRole.switchboard
            ? [deps.config.demoLinesByRole.switchboard]
            : [],
        }
      : { mode: 'live', allowlist: deps.config.liveAllowlist }

  // Demo mode dials the switchboard line whoever the counterparty is; live mode
  // hands demoLine the real number so the allowlist is what decides.
  const destination = (real: string | null): string =>
    demoLine(policy, deps.config.mode === 'demo' ? deps.config.demoLinesByRole.switchboard : real)

  const lookupShop = (shopId: unknown): Shop => {
    const shop = typeof shopId === 'string' ? deps.shops.find((s) => s.id === shopId) : undefined
    if (!shop) throw new Error('UNKNOWN_SHOP')
    return shop
  }

  const lookupTasker = (taskerId: unknown): TaskerProfile => {
    const profile = typeof taskerId === 'string' ? deps.taskers.get(taskerId) : undefined
    if (!profile) throw new Error('UNKNOWN_TASKER')
    return profile
  }

  // Every phone call is a 0-cent "call" spend with no counterparty attached:
  // a call is not a handover, and putting a counterparty on it would let a
  // stranger accrue a track record just by answering the phone.
  const commitCall = (merchant: string): void => {
    deps.gate.commit({ merchant, amountCents: 0, category: 'call' }, now())
  }

  const handlers = {
    async findShops(input: z.infer<typeof FindShopsInput>): Promise<Json> {
      const wanted = input.service.trim().toLowerCase()
      const matches = deps.shops.filter((s) =>
        s.services.some((offered) => offered.toLowerCase().includes(wanted)),
      )
      const found = matches.length > 0 ? matches : deps.shops
      log(`shops for "${input.service}" -> ${found.map((s) => s.name).join(', ') || 'nothing'}`)
      return found.map((s) => ({
        id: s.id,
        name: s.name,
        address: s.address,
        services: s.services,
        hasPhone: s.phone !== null,
      }))
    },

    async book(input: z.infer<typeof BookInput>): Promise<Json> {
      const shop = lookupShop(input.shopId)
      if (callsMade >= maxCalls) return { status: 'refused', reason: 'CALL_LIMIT_REACHED' }
      let to: string
      try {
        to = destination(shop.phone)
        commitCall(shop.name)
      } catch (error) {
        const reason =
          error instanceof PhoneError || error instanceof GateError ? error.message : 'CALL_REFUSED'
        return { status: 'refused', reason }
      }
      callsMade += 1
      log(
        `calling ${shop.name} (call ${callsMade}${deps.config.mode === 'demo' ? ', demo line' : ''})`,
      )
      const result = await deps.runCall({
        to,
        assistant: buildServiceAssistant(
          {
            shopName: shop.name,
            customerName: deps.config.customerName,
            vehicle: input.vehicle,
            service: input.service,
            window: input.window,
          },
          deps.voice,
        ),
      })
      const outcome = parseOutcome(ServiceOutcomeSchema, result.structuredData)
      if (outcome?.booked) {
        bookings.set(shop.id, { quoteCents: outcome.quoteCents, slot: outcome.slot })
        if (outcome.slot) bookedSlot = outcome.slot
        // ALREADY_PAID guards a single booking, not the shop forever: a new
        // booked outcome is a new visit with a new payable quote, so a prior
        // payment for this shop no longer blocks pay_service.
        paidShops.delete(shop.id)
      } else {
        // A later not-booked (or unclear) call invalidates an earlier stored
        // quote: nobody stays payable off a booking that no longer stands.
        bookings.delete(shop.id)
        bookedSlot =
          [...bookings.values()]
            .map((b) => b.slot)
            .filter((x) => x !== null)
            .at(-1) ?? null
      }
      log(
        `${shop.name}: ${outcome ? (outcome.booked ? `booked ${outcome.slot ?? ''}` : 'not booked') : 'no clear outcome'}`,
      )
      return {
        status: 'completed',
        shop: shop.name,
        booked: outcome?.booked ?? false,
        slot: outcome?.slot ?? null,
        quoteCents: outcome?.quoteCents ?? 0,
        confirmation: outcome?.confirmation ?? null,
        notes: outcome?.notes ?? 'The call ended without a clear answer.',
        summary: result.summary,
      }
    },

    async pay(input: z.infer<typeof PayInput>): Promise<Json> {
      const shop = lookupShop(input.shopId)
      // The mapper already refuses a second payment for the same shop before a
      // human is asked; this is defense-in-depth for a direct handler call.
      if (paidShops.has(shop.id)) return { status: 'refused', reason: 'ALREADY_PAID' }
      const request: SpendRequest = {
        merchant: shop.name,
        amountCents: input.amountCents,
        category: 'service_booking',
      }
      try {
        deps.gate.commit(request, now(), input.approvalCode)
      } catch (error) {
        return { status: 'refused', reason: error instanceof GateError ? error.reason : 'REFUSED' }
      }
      const receipt = await deps.deposits.charge({
        amountCents: input.amountCents,
        description: `Errands service: ${shop.name}`,
        idempotencyKey: `${errandId}-${shop.id}-service`,
      })
      paidShops.add(shop.id)
      log(`service payment ${receipt.status}: ${shop.name}`)
      return {
        status: 'paid',
        paymentId: receipt.id,
        amountCents: receipt.amountCents,
        testMode: true,
      }
    },

    async findTaskers(input: z.infer<typeof FindTaskersInput>): Promise<Json> {
      const found = [...(await deps.taskers.find(input.taskClass))].sort(
        (a, b) => scoreTasker(b) - scoreTasker(a),
      )
      log(`taskers for ${input.taskClass} -> ${found.map((t) => t.name).join(', ') || 'nobody'}`)
      return found.map((t) => ({
        id: t.id,
        name: t.name,
        rating: t.rating,
        jobs: t.jobs,
        backgroundCheck: t.backgroundCheck,
        insuredFor: t.insuredFor,
        yearsActive: t.yearsActive,
        rateCents: t.rateCents,
      }))
    },

    // Paper vetting first, so a tasker who cannot pass the policy is never
    // phoned. Before any of that: there has to be a real appointment. The
    // model may pass `input.slot`, and it is kept so the schema still reads
    // naturally to the model, but the BOOKED slot always wins. Screening a
    // driver for a slot the shop never agreed to produces a "yes, I can make
    // it" about an appointment that does not exist.
    async vet(input: z.infer<typeof VetInput>): Promise<Json> {
      const profile = lookupTasker(input.taskerId)
      if (bookedSlot === null) return { status: 'refused', reason: 'NO_BOOKING_YET' }
      const slot = bookedSlot
      const paper = vet(profile, deps.vetting, TASK_CLASS)
      if (!paper.passed) {
        log(`${profile.name} failed vetting: ${paper.failures.join(', ')}`)
        // A later paper failure invalidates an earlier passed screen: nobody
        // stays hireable off a stale pass once they fail vetting again.
        screens.delete(profile.id)
        return { passed: false, failures: paper.failures }
      }
      if (callsMade >= maxCalls) return { status: 'refused', reason: 'CALL_LIMIT_REACHED' }
      let to: string
      try {
        to = destination(profile.phone)
        commitCall(profile.name)
      } catch (error) {
        const reason =
          error instanceof PhoneError || error instanceof GateError ? error.message : 'CALL_REFUSED'
        return { status: 'refused', reason }
      }
      callsMade += 1
      log(
        `screening ${profile.name} (call ${callsMade}${deps.config.mode === 'demo' ? ', demo line' : ''})`,
      )
      const result = await deps.runCall({
        to,
        assistant: buildScreenAssistant(
          {
            taskerName: profile.name,
            customerName: deps.config.customerName,
            task: SCREEN_TASK,
            slot,
            questions: [...SCREEN_QUESTIONS],
          },
          deps.voice,
        ),
      })
      const outcome = parseOutcome(ScreenOutcomeSchema, result.structuredData)
      const failures: string[] = []
      if (!outcome) failures.push('SCREEN_NO_OUTCOME')
      else {
        if (!outcome.available) failures.push('SCREEN_UNAVAILABLE')
        for (const key of SCREEN_KEYS) {
          if (!resolveScreenAnswer(outcome.answers, key)) failures.push(`SCREEN_ANSWER_${key}`)
        }
      }
      const passed = failures.length === 0
      if (passed) {
        // The screen is what lifts a stranger off the "unknown" rung. Only a
        // passed screen is stored, so hire_tasker has nothing to work with
        // for anyone else. Record the screen event at most once per tasker:
        // repeating it would manufacture a track record just by re-dialing
        // someone who already passed.
        if (!screenedRecorded.has(profile.id)) {
          deps.gate.recordScreened(profile.id, now())
          screenedRecorded.add(profile.id)
        }
        screens.set(profile.id, { slot })
      } else {
        // A later failed screen invalidates any earlier passed one.
        screens.delete(profile.id)
      }
      log(`${profile.name} screen: ${passed ? 'passed' : failures.join(', ')}`)
      return {
        passed,
        failures,
        screen: outcome
          ? { available: outcome.available, answers: { ...outcome.answers }, notes: outcome.notes }
          : null,
      }
    },

    async hire(input: z.infer<typeof HireInput>): Promise<Json> {
      const profile = lookupTasker(input.taskerId)
      const screen = screens.get(profile.id)
      if (!screen) return { status: 'refused', reason: 'NOT_SCREENED' }
      const request: SpendRequest = {
        merchant: profile.name,
        amountCents: profile.rateCents,
        category: 'hire',
        counterpartyId: profile.id,
        handover: true,
      }
      try {
        deps.gate.commit(request, now(), input.approvalCode)
      } catch (error) {
        return { status: 'refused', reason: error instanceof GateError ? error.reason : 'REFUSED' }
      }
      const receipt = await deps.deposits.charge({
        amountCents: profile.rateCents,
        description: `Errands hire: ${profile.name}`,
        idempotencyKey: `${errandId}-${profile.id}-hire`,
      })
      log(`hired ${profile.name} for ${screen.slot}`)
      return {
        status: 'hired',
        tasker: profile.name,
        taskerId: profile.id,
        amountCents: receipt.amountCents,
        slot: screen.slot,
        paymentId: receipt.id,
        testMode: true,
      }
    },
  }

  // What the gate sees for each spend-capable tool. Two of these refuse before
  // a human is ever asked: an amount the shop did not quote, and a human who
  // has not been screened.
  const spendTools = new Map<string, SpendInputMapper>([
    [
      'book_service',
      (input) => ({
        merchant: lookupShop((input as { shopId?: unknown }).shopId).name,
        amountCents: 0,
        category: 'call',
      }),
    ],
    [
      'pay_service',
      (input) => {
        const { shopId, amountCents } = input as { shopId?: unknown; amountCents?: unknown }
        const shop = lookupShop(shopId)
        if (paidShops.has(shop.id)) throw new Error('ALREADY_PAID')
        const booking = bookings.get(shop.id)
        if (!booking || booking.quoteCents <= 0) throw new Error('NO_QUOTE')
        if (amountCents !== booking.quoteCents) throw new Error('AMOUNT_NOT_QUOTED')
        return {
          merchant: shop.name,
          amountCents: booking.quoteCents,
          category: 'service_booking',
          triedFirst: 'called the shop, which quoted this amount',
        }
      },
    ],
    [
      'vet_tasker',
      (input) => ({
        merchant: lookupTasker((input as { taskerId?: unknown }).taskerId).name,
        amountCents: 0,
        category: 'call',
      }),
    ],
    [
      'hire_tasker',
      (input) => {
        const profile = lookupTasker((input as { taskerId?: unknown }).taskerId)
        if (!screens.has(profile.id)) throw new Error('NOT_SCREENED')
        return {
          merchant: profile.name,
          amountCents: profile.rateCents,
          category: 'hire',
          counterpartyId: profile.id,
          handover: true,
          evidence: `${profile.rating} stars, ${profile.jobs} jobs, background checked, insured for vehicles, screened by phone`,
          triedFirst: 'vetted the profile and screened them by phone',
        }
      },
    ],
  ])

  const tools = [
    tool({
      name: 'find_shops',
      description:
        'Find service shops that do the work the car needs. Returns ids to use with book_service.',
      inputSchema: FindShopsInput,
      callback: (input) => handlers.findShops(input),
    }),
    tool({
      name: 'book_service',
      description:
        'Phone one shop (an AI voice call) to book the work. Returns the slot, the quote and any confirmation.',
      inputSchema: BookInput,
      callback: (input) => handlers.book(input),
    }),
    tool({
      name: 'pay_service',
      description:
        'Pay the shop exactly the amount it quoted on the call. A human approves every payment.',
      inputSchema: PayInput,
      callback: (input) => handlers.pay(input),
    }),
    tool({
      name: 'find_taskers',
      description:
        'List task-marketplace taskers who take this class of job, best first. Returns ids to use with vet_tasker.',
      inputSchema: FindTaskersInput,
      callback: (input) => handlers.findTaskers(input),
    }),
    tool({
      name: 'vet_tasker',
      description:
        'Check one tasker against the vetting policy and, if they pass on paper, phone-screen them. Nobody can be hired without a passed screen.',
      inputSchema: VetInput,
      callback: (input) => handlers.vet(input),
    }),
    tool({
      name: 'hire_tasker',
      description:
        'Hire the tasker who passed the phone screen to drive the car. A human approves the first time anyone holds their property.',
      inputSchema: HireInput,
      callback: (input) => handlers.hire(input),
    }),
  ]

  return { name: 'blurr', tools, spendTools, promptLines, handlers }
}

const FindShopsInput = z.object({
  service: z
    .string()
    .min(2)
    .max(80)
    .describe('The work the car needs, e.g. "oil change" or "tire rotation"'),
})

const BookInput = z.object({
  shopId: z.string().describe('An id returned by find_shops'),
  vehicle: z.string().min(2).max(80).describe('Year, make and model, e.g. "2016 Honda Civic"'),
  service: z.string().min(2).max(80).describe('The work to book, e.g. "oil change"'),
  window: z.string().min(1).max(80).describe('Acceptable window, e.g. "any weekday this week"'),
})

const PayInput = z.object({
  shopId: z.string(),
  amountCents: z.number().int().positive(),
  approvalCode: z.string().optional().describe('Leave empty. Filled in by the approval system.'),
})

const FindTaskersInput = z.object({
  taskClass: z.string().min(2).max(40).describe('The class of job, e.g. "vehicle"'),
})

const VetInput = z.object({
  taskerId: z.string().describe('An id returned by find_taskers'),
  slot: z.string().min(1).max(80).describe('The slot they would work, e.g. "Tuesday 8:00 AM"'),
})

const HireInput = z.object({
  taskerId: z.string().describe('An id returned by find_taskers that passed vet_tasker'),
  approvalCode: z.string().optional().describe('Leave empty. Filled in by the approval system.'),
})
