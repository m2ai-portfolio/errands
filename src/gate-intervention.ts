import { InterventionActions, InterventionHandler } from '@strands-agents/sdk'
import type { BeforeToolCallEvent, OnError } from '@strands-agents/sdk'
import type { Gate, SpendRequest } from './gate.js'

// Point of intent: this intervention runs before EVERY tool call the model makes.
// Spend-capable tools are checked against the gate; forbidden calls never run,
// "confirm" calls pause for the human, and the approval code is injected here,
// never produced by the model. Point of action: the tool itself calls
// gate.commit(), which refuses confirm-category spend without a valid code.

export type SpendInputMapper = (input: unknown) => SpendRequest
export type AskHuman = (prompt: string) => Promise<boolean>

type JsonObject = Record<string, unknown>

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const formatCents = (cents: number): string => `$${(cents / 100).toFixed(2)}`

export class SpendingGateIntervention extends InterventionHandler {
  readonly name = 'errands:spending-gate'
  override readonly onError: OnError = 'deny'

  constructor(
    private readonly gate: Gate,
    private readonly spendTools: ReadonlyMap<string, SpendInputMapper>,
    private readonly askHuman: AskHuman,
    private readonly now: () => Date = () => new Date(),
  ) {
    super()
  }

  override async beforeToolCall(event: BeforeToolCallEvent) {
    const toRequest = this.spendTools.get(event.toolUse.name)
    if (!toRequest) return InterventionActions.proceed()

    const input = event.toolUse.input
    let request: SpendRequest
    try {
      if (!isObject(input)) throw new Error('not an object')
      request = toRequest(input)
    } catch {
      return InterventionActions.deny('Spending gate: SPEND_INPUT_INVALID')
    }

    const at = this.now()
    const evaluation = this.gate.evaluate(request, at)
    if (evaluation.decision === 'forbid') {
      return InterventionActions.deny(`Spending gate: ${evaluation.reason}`)
    }

    // Whatever the model put in approvalCode is discarded on every path.
    const { approvalCode: _discarded, ...cleanInput } = input as JsonObject
    if (evaluation.decision === 'allow') {
      return InterventionActions.transform(
        (e) => {
          ;(e as BeforeToolCallEvent).toolUse.input =
            cleanInput as BeforeToolCallEvent['toolUse']['input']
        },
        { reason: evaluation.reason },
      )
    }

    const approval = this.gate.requestApproval(request, at)
    const approved = await this.askHuman(
      `Errands wants to spend ${formatCents(request.amountCents)} (${request.category}) at ${request.merchant}. Approve?`,
    )
    if (!approved) return InterventionActions.deny('Spending gate: HUMAN_DECLINED')
    return InterventionActions.transform(
      (e) => {
        ;(e as BeforeToolCallEvent).toolUse.input = {
          ...cleanInput,
          approvalCode: approval.code,
        } as BeforeToolCallEvent['toolUse']['input']
      },
      { reason: 'HUMAN_APPROVED' },
    )
  }
}
