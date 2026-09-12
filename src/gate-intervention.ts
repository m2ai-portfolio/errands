import { InterventionActions, InterventionHandler } from '@strands-agents/sdk'
import type { BeforeToolCallEvent, OnError } from '@strands-agents/sdk'
import type { Gate, SpendRequest } from './gate.js'
import { categoryLabel } from './labels.js'
import { sanitizeForPrompt } from './sanitize.js'
import type { StepUpChannel } from './stepup.js'

// Point of intent: this intervention runs before EVERY tool call the model makes.
// Spend-capable tools are checked against the gate; forbidden calls never run,
// "notify" calls proceed and tell the human afterwards, "confirm" calls pause
// for the human (with the approval code delivered out of band at or above
// stepUpCents), and the approval code is injected here, never produced by the
// model. Point of action: the tool itself calls gate.commit(), which refuses
// confirm-category spend without a valid code.

export type MappedSpend = SpendRequest & { evidence?: string; triedFirst?: string }
export type SpendInputMapper = (input: unknown) => MappedSpend
export type AskHuman = (prompt: string, options?: { expectCode?: string }) => Promise<boolean>

type JsonObject = Record<string, unknown>

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const formatCents = (cents: number): string => `$${(cents / 100).toFixed(2)}`

// "Maria R." already ends in a period; appending another gives "Maria R..".
const noTrailingPeriod = (text: string): string => text.replace(/\.+$/, '')

// One sentence per category, because "$0.00 (cancellation) at Netflix" is not
// what is actually being decided. The amount is dropped where it is always
// zero, and the raw category key never reaches the human.
export function describeSpend(category: string, who: string, amountCents: number): string {
  const name = noTrailingPeriod(who)
  if (category === 'cancellation') return `Errands wants to cancel your ${name} subscription.`
  if (category === 'hire') return `Errands wants to hire ${name} for ${formatCents(amountCents)}.`
  return `Errands wants to spend ${formatCents(amountCents)} (${categoryLabel(category)}) at ${name}.`
}

export class SpendingGateIntervention extends InterventionHandler {
  readonly name = 'errands:spending-gate'
  override readonly onError: OnError = 'deny'

  constructor(
    private readonly gate: Gate,
    private readonly spendTools: ReadonlyMap<string, SpendInputMapper>,
    private readonly askHuman: AskHuman,
    private readonly stepUp: StepUpChannel,
    private readonly notify: (line: string) => void,
    private readonly now: () => Date = () => new Date(),
  ) {
    super()
  }

  override async beforeToolCall(event: BeforeToolCallEvent) {
    const toRequest = this.spendTools.get(event.toolUse.name)
    if (!toRequest) return InterventionActions.proceed()

    const input = event.toolUse.input
    let mapped: MappedSpend
    try {
      if (!isObject(input)) throw new Error('not an object')
      mapped = toRequest(input)
    } catch (err) {
      const detail = err instanceof Error && err.message ? `: ${err.message}` : ''
      return InterventionActions.deny(`Spending gate: SPEND_INPUT_INVALID${detail}`)
    }

    const { evidence, triedFirst, ...request } = mapped
    const at = this.now()
    const evaluation = this.gate.evaluate(request, at)
    if (evaluation.decision === 'forbid') {
      return InterventionActions.deny(`Spending gate: ${evaluation.reason}`)
    }

    // Whatever the model put in approvalCode is discarded on every path.
    const { approvalCode: _discarded, ...cleanInput } = input as JsonObject
    const setInput =
      (value: JsonObject) =>
      (e: BeforeToolCallEvent | unknown): void => {
        ;(e as BeforeToolCallEvent).toolUse.input = value as BeforeToolCallEvent['toolUse']['input']
      }

    if (evaluation.decision === 'allow') {
      return InterventionActions.transform(setInput(cleanInput), { reason: evaluation.reason })
    }

    // Display only. The bound request keeps the raw merchant, because the
    // approval code is bound to it and checkApproval compares the raw value.
    const who = sanitizeForPrompt(request.merchant)

    if (evaluation.decision === 'notify') {
      this.notify(
        `Errands is spending ${formatCents(request.amountCents)} (${request.category}) at ${who} on its track record (rung ${evaluation.rung}). No approval needed.`,
      )
      return InterventionActions.transform(setInput(cleanInput), { reason: evaluation.reason })
    }

    const approval = this.gate.requestApproval(request, at)
    const why =
      evaluation.reason === 'FIRST_HANDOVER'
        ? ' This is the first time they would hold your property.'
        : ''
    const prompt = `${describeSpend(request.category, who, request.amountCents)}${evidence ? ` ${evidence}.` : ''}${why} Approve?`

    let approved: boolean
    if (evaluation.stepUp) {
      await this.stepUp(approval.code, {
        who,
        amountCents: request.amountCents,
        category: request.category,
        triedFirst: triedFirst ?? 'checked the policy',
      })
      approved = await this.askHuman(prompt, { expectCode: approval.code })
    } else {
      approved = await this.askHuman(prompt)
    }

    if (!approved) {
      // Spec rule: "human declined after vetting" is an incident. Without this
      // the down-rung half of the trust ladder is never reachable in the
      // product; a counterparty the human just refused would keep its rung.
      if (request.counterpartyId) {
        this.gate.recordIncident(request.counterpartyId, 'human declined', at)
      }
      return InterventionActions.deny('Spending gate: HUMAN_DECLINED')
    }
    return InterventionActions.transform(setInput({ ...cleanInput, approvalCode: approval.code }), {
      reason: 'HUMAN_APPROVED',
    })
  }
}
