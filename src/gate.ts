import { randomInt } from 'node:crypto'
import {
  agentCounterparty,
  rungOf,
  type CounterpartyGrant,
  type Rung,
  type TrustEvent,
  type VettingPolicy,
} from './trust.js'

// The spending gate is deterministic code, not a prompt. Every money-moving tool
// call is checked here, and a human-issued approval code is required for any
// category the policy marks "confirm". The model never sees or holds a card.

export type CategoryMode = 'allow' | 'confirm' | 'forbid'

export interface Policy {
  enabled: boolean
  perTransactionCapCents: number
  dailyCapCents: number
  weeklyCapCents: number
  approvalTtlMinutes: number
  stepUpCents: number
  promoteAfter: number
  notifyCapCents: Record<string, number>
  vetting: VettingPolicy
  counterparties: Record<string, CounterpartyGrant>
  categories: Record<string, CategoryMode>
}

export interface SpendRequest {
  merchant: string
  amountCents: number
  category: string
  counterpartyId?: string
  handover?: boolean
}

export interface LedgerEntry extends SpendRequest {
  at: string
  approvedBy: 'policy' | 'human' | 'track-record'
}

export type Decision = 'allow' | 'notify' | 'confirm' | 'forbid'

export type GateReason =
  | 'ALLOW_CATEGORY'
  | 'CONFIRM_CATEGORY'
  | 'TRACK_RECORD'
  | 'FIRST_HANDOVER'
  | 'COUNTERPARTY_UNKNOWN'
  | 'KILL_SWITCH'
  | 'INVALID_AMOUNT'
  | 'UNKNOWN_CATEGORY'
  | 'CATEGORY_FORBIDDEN'
  | 'OVER_TRANSACTION_CAP'
  | 'OVER_DAILY_CAP'
  | 'OVER_WEEKLY_CAP'

export type GateErrorReason =
  | GateReason
  | 'NOT_CONFIRMABLE'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_INVALID'
  | 'APPROVAL_EXPIRED'
  | 'APPROVAL_USED'

export interface Evaluation {
  decision: Decision
  reason: GateReason
  stepUp: boolean
  rung: Rung
}

export interface Approval {
  code: string
  expiresAt: Date
}

export class GateError extends Error {
  constructor(readonly reason: GateErrorReason) {
    super(`Spending gate refused: ${reason}`)
    this.name = 'GateError'
  }
}

const DAY_MS = 86_400_000

interface PendingApproval {
  request: SpendRequest
  expiresAt: Date
  used: boolean
}

const counterpartyOf = (request: SpendRequest): string =>
  request.counterpartyId ?? agentCounterparty(request.category)

export function createGate(
  policy: Policy,
  initialLedger: readonly LedgerEntry[] = [],
  initialEvents: readonly TrustEvent[] = [],
) {
  const entries: LedgerEntry[] = [...initialLedger]
  const events: TrustEvent[] = [...initialEvents]
  const approvals = new Map<string, PendingApproval>()

  const spentWithin = (now: Date, windowMs: number): number =>
    entries
      .filter((entry) => {
        const at = Date.parse(entry.at)
        return at > now.getTime() - windowMs && at <= now.getTime()
      })
      .reduce((sum, entry) => sum + entry.amountCents, 0)

  const rungFor = (request: SpendRequest): Rung =>
    rungOf(
      counterpartyOf(request),
      policy.counterparties,
      events,
      policy.promoteAfter,
      request.counterpartyId ? 'unknown' : 'screened',
    )

  const hadCleanHandover = (id: string): boolean =>
    events.some((e) => e.counterpartyId === id && e.kind === 'clean' && e.detail === 'handover')

  function evaluate(request: SpendRequest, now: Date): Evaluation {
    const rung = rungFor(request)
    const forbid = (reason: GateReason): Evaluation => ({
      decision: 'forbid',
      reason,
      stepUp: false,
      rung,
    })
    if (!policy.enabled) return forbid('KILL_SWITCH')
    const { amountCents, category } = request
    if (!Number.isInteger(amountCents) || amountCents < 0) return forbid('INVALID_AMOUNT')
    const mode = Object.hasOwn(policy.categories, category)
      ? policy.categories[category]
      : undefined
    if (mode === undefined) return forbid('UNKNOWN_CATEGORY')
    if (mode === 'forbid') return forbid('CATEGORY_FORBIDDEN')
    if (amountCents > policy.perTransactionCapCents) return forbid('OVER_TRANSACTION_CAP')
    if (spentWithin(now, DAY_MS) + amountCents > policy.dailyCapCents)
      return forbid('OVER_DAILY_CAP')
    if (spentWithin(now, 7 * DAY_MS) + amountCents > policy.weeklyCapCents) {
      return forbid('OVER_WEEKLY_CAP')
    }
    if (mode === 'allow')
      return { decision: 'allow', reason: 'ALLOW_CATEGORY', stepUp: false, rung }
    if (request.counterpartyId && rung === 'unknown') return forbid('COUNTERPARTY_UNKNOWN')
    const stepUp = amountCents >= policy.stepUpCents
    if (request.handover && !hadCleanHandover(counterpartyOf(request))) {
      return { decision: 'confirm', reason: 'FIRST_HANDOVER', stepUp, rung }
    }
    const notifyCap = policy.notifyCapCents[category] ?? 0
    if ((rung === 'proven' || rung === 'trusted') && amountCents <= notifyCap) {
      return { decision: 'notify', reason: 'TRACK_RECORD', stepUp: false, rung }
    }
    return { decision: 'confirm', reason: 'CONFIRM_CATEGORY', stepUp, rung }
  }

  function requestApproval(request: SpendRequest, now: Date): Approval {
    const evaluation = evaluate(request, now)
    if (evaluation.decision === 'forbid') throw new GateError(evaluation.reason)
    if (evaluation.decision !== 'confirm') throw new GateError('NOT_CONFIRMABLE')
    let code: string
    do code = randomInt(0, 1_000_000).toString().padStart(6, '0')
    while (approvals.has(code))
    const expiresAt = new Date(now.getTime() + policy.approvalTtlMinutes * 60_000)
    approvals.set(code, { request: { ...request }, expiresAt, used: false })
    return { code, expiresAt }
  }

  function checkApproval(code: string, request: SpendRequest, now: Date): PendingApproval {
    const pending = approvals.get(code)
    if (!pending) throw new GateError('APPROVAL_INVALID')
    if (pending.used) throw new GateError('APPROVAL_USED')
    if (now.getTime() > pending.expiresAt.getTime()) throw new GateError('APPROVAL_EXPIRED')
    const bound = pending.request
    if (
      bound.merchant !== request.merchant ||
      bound.amountCents !== request.amountCents ||
      bound.category !== request.category ||
      (bound.counterpartyId ?? null) !== (request.counterpartyId ?? null) ||
      Boolean(bound.handover) !== Boolean(request.handover)
    ) {
      throw new GateError('APPROVAL_INVALID')
    }
    return pending
  }

  // Validates the code first, then re-runs the full policy (caps may have been
  // used up since the code was issued), and only then writes the ledger.
  function commit(request: SpendRequest, now: Date, code?: string): LedgerEntry {
    const pending = code === undefined ? undefined : checkApproval(code, request, now)
    const evaluation = evaluate(request, now)
    if (evaluation.decision === 'forbid') throw new GateError(evaluation.reason)
    if (evaluation.decision === 'confirm' && !pending) throw new GateError('APPROVAL_REQUIRED')
    if (pending) pending.used = true
    const entry: LedgerEntry = {
      merchant: request.merchant,
      amountCents: request.amountCents,
      category: request.category,
      ...(request.counterpartyId ? { counterpartyId: request.counterpartyId } : {}),
      ...(request.handover ? { handover: true } : {}),
      at: now.toISOString(),
      approvedBy: pending ? 'human' : evaluation.decision === 'notify' ? 'track-record' : 'policy',
    }
    entries.push(entry)
    if (evaluation.decision !== 'allow') {
      events.push({
        counterpartyId: counterpartyOf(request),
        kind: 'clean',
        detail: request.handover ? 'handover' : request.category,
        at: now.toISOString(),
      })
    }
    return entry
  }

  function recordIncident(counterpartyId: string, detail: string, now: Date): TrustEvent {
    const event: TrustEvent = { counterpartyId, kind: 'incident', detail, at: now.toISOString() }
    events.push(event)
    return event
  }

  function recordScreened(counterpartyId: string, now: Date): TrustEvent {
    const event: TrustEvent = {
      counterpartyId,
      kind: 'clean',
      detail: 'screened',
      at: now.toISOString(),
    }
    events.push(event)
    return event
  }

  return {
    evaluate,
    requestApproval,
    commit,
    recordIncident,
    recordScreened,
    rungFor,
    ledger: (): readonly LedgerEntry[] => [...entries],
    events: (): readonly TrustEvent[] => [...events],
  }
}

export type Gate = ReturnType<typeof createGate>
