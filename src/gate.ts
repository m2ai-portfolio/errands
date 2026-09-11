import { randomInt } from 'node:crypto'

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
  categories: Record<string, CategoryMode>
}

export interface SpendRequest {
  merchant: string
  amountCents: number
  category: string
}

export interface LedgerEntry extends SpendRequest {
  at: string
  approvedBy: 'policy' | 'human'
}

export type Decision = 'allow' | 'confirm' | 'forbid'

export type GateReason =
  | 'ALLOW_CATEGORY'
  | 'CONFIRM_CATEGORY'
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

export function createGate(policy: Policy, initialLedger: readonly LedgerEntry[] = []) {
  const entries: LedgerEntry[] = [...initialLedger]
  const approvals = new Map<string, PendingApproval>()

  const spentWithin = (now: Date, windowMs: number): number =>
    entries
      .filter((entry) => {
        const at = Date.parse(entry.at)
        return at > now.getTime() - windowMs && at <= now.getTime()
      })
      .reduce((sum, entry) => sum + entry.amountCents, 0)

  const forbid = (reason: GateReason): Evaluation => ({ decision: 'forbid', reason })

  function evaluate(request: SpendRequest, now: Date): Evaluation {
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
    return mode === 'confirm'
      ? { decision: 'confirm', reason: 'CONFIRM_CATEGORY' }
      : { decision: 'allow', reason: 'ALLOW_CATEGORY' }
  }

  function requestApproval(request: SpendRequest, now: Date): Approval {
    const evaluation = evaluate(request, now)
    if (evaluation.decision === 'forbid') throw new GateError(evaluation.reason)
    if (evaluation.decision === 'allow') throw new GateError('NOT_CONFIRMABLE')
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
      bound.category !== request.category
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
      at: now.toISOString(),
      approvedBy: pending ? 'human' : 'policy',
    }
    entries.push(entry)
    return entry
  }

  return {
    evaluate,
    requestApproval,
    commit,
    ledger: (): readonly LedgerEntry[] => [...entries],
  }
}

export type Gate = ReturnType<typeof createGate>
