// Bank data sources: a fixture for tests/dev, and a Stripe Financial Connections
// implementation. Stripe TEST MODE only: the constructor refuses a live key, same
// guard as deposit.ts.

import { z } from 'zod'
import type { Transaction } from './recurring.js'

type FetchLike = (url: string, init: RequestInit) => Promise<Response>
type SleepLike = (ms: number) => Promise<void>

export interface BankAccount {
  id: string
  institution: string
  last4: string
}

export interface BankSource {
  readonly source: 'fixture' | 'stripe'
  connect(): Promise<BankAccount>
  transactions(accountId: string): Promise<Transaction[]>
}

export const FC_BASE = 'https://api.stripe.com/v1/financial_connections'

const POLL_INTERVAL_MS = 3_000
const POLL_TIMEOUT_MS = 120_000

export class FixtureBank implements BankSource {
  readonly source = 'fixture' as const

  constructor(private readonly rows: Transaction[]) {}

  async connect(): Promise<BankAccount> {
    return { id: 'fixture-checking', institution: 'Demo Bank', last4: '0000' }
  }

  async transactions(_accountId: string): Promise<Transaction[]> {
    return this.rows
  }
}

interface StripeFinancialConnectionsOptions {
  secretKey: string
  customerId: string
  collect: (clientSecret: string) => Promise<string[]>
  fetchFn?: FetchLike
  sleep?: SleepLike
}

interface FcAccount {
  id: string
  institution_name?: string
  last4?: string
  transaction_refresh?: { status: 'pending' | 'succeeded' | 'failed' } | null
}

// Runtime validation for whatever the Stripe API actually sends back. A bank
// row is untrusted input: fields can be missing, `null`, or the wrong type
// without the HTTP call itself failing, so each row is checked here rather
// than just type-cast. Rows that fail validation are dropped, not thrown on,
// so one bad row from the bank cannot crash the whole listing.
export const StripeTransactionRowSchema = z.object({
  id: z.string(),
  description: z.preprocess((v) => (v === null || v === undefined ? '' : v), z.coerce.string()),
  amount: z.number(),
  status: z.enum(['pending', 'posted', 'void']),
  transacted_at: z.number().int().gt(0).lt(4102444800),
})

type FcTransaction = z.infer<typeof StripeTransactionRowSchema>

export class StripeFinancialConnections implements BankSource {
  readonly source = 'stripe' as const

  private readonly secretKey: string
  private readonly customerId: string
  private readonly collect: (clientSecret: string) => Promise<string[]>
  private readonly fetchFn: FetchLike
  private readonly sleep: SleepLike

  constructor(opts: StripeFinancialConnectionsOptions) {
    if (!/^(sk|rk)_test_/.test(opts.secretKey)) throw new Error('STRIPE_TEST_KEY_REQUIRED')
    this.secretKey = opts.secretKey
    this.customerId = opts.customerId
    this.collect = opts.collect
    this.fetchFn = opts.fetchFn ?? fetch
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    }
  }

  async connect(): Promise<BankAccount> {
    const body = new URLSearchParams({
      'account_holder[type]': 'customer',
      'account_holder[customer]': this.customerId,
      'permissions[]': 'transactions',
      'prefetch[]': 'transactions',
    })
    const response = await this.fetchFn(`${FC_BASE}/sessions`, {
      method: 'POST',
      headers: this.authHeaders(),
      body,
      signal: AbortSignal.timeout(20_000),
    })
    const session = (await response.json()) as {
      id?: string
      client_secret?: string
      error?: { code?: string; message?: string }
    }
    if (!response.ok || !session.client_secret || !session.id) {
      throw new Error(`STRIPE_${session.error?.code ?? response.status}`)
    }

    const collectedIds = await this.collect(session.client_secret)
    if (collectedIds.length === 0) throw new Error('FC_NO_ACCOUNT_SELECTED')

    const sessionAccountIds = await this.getSessionAccountIds(session.id)
    const accountIds = collectedIds.filter((id) => sessionAccountIds.has(id))
    const accountId = accountIds[0]
    if (!accountId) throw new Error('FC_ACCOUNT_NOT_IN_SESSION')

    const account = await this.getAccount(accountId)
    return {
      id: account.id,
      institution: account.institution_name ?? 'Unknown',
      last4: account.last4 ?? '',
    }
  }

  // Server-side check that an id the browser reported actually belongs to the
  // Financial Connections session we created, so a tampered /done payload
  // (see connect-page.ts) cannot smuggle in an account from elsewhere.
  private async getSessionAccountIds(sessionId: string): Promise<Set<string>> {
    const response = await this.fetchFn(`${FC_BASE}/sessions/${sessionId}`, {
      method: 'GET',
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(20_000),
    })
    const json = (await response.json()) as {
      accounts?: { data?: { id: string }[] }
      error?: { code?: string }
    }
    if (!response.ok) {
      throw new Error(`STRIPE_${json.error?.code ?? response.status}`)
    }
    return new Set((json.accounts?.data ?? []).map((a) => a.id))
  }

  private async getAccount(accountId: string): Promise<FcAccount> {
    const response = await this.fetchFn(`${FC_BASE}/accounts/${accountId}`, {
      method: 'GET',
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(20_000),
    })
    const json = (await response.json()) as FcAccount & { error?: { code?: string } }
    if (!response.ok || !json.id) {
      throw new Error(`STRIPE_${json.error?.code ?? response.status}`)
    }
    return json
  }

  private async requestRefresh(accountId: string): Promise<void> {
    const body = new URLSearchParams({ 'features[]': 'transactions' })
    const response = await this.fetchFn(`${FC_BASE}/accounts/${accountId}/refresh`, {
      method: 'POST',
      headers: this.authHeaders(),
      body,
      signal: AbortSignal.timeout(20_000),
    })
    // Stripe rate-limits refreshes; a 400 here (e.g. already refreshing) is not fatal.
    if (!response.ok && response.status !== 400) {
      const json = (await response.json().catch(() => ({}))) as { error?: { code?: string } }
      throw new Error(`STRIPE_${json.error?.code ?? response.status}`)
    }
  }

  private async waitForRefresh(accountId: string): Promise<void> {
    let waitedMs = 0
    for (;;) {
      const account = await this.getAccount(accountId)
      const status = account.transaction_refresh?.status
      if (status === 'succeeded') return
      if (status === 'failed') throw new Error('FC_REFRESH_FAILED')
      if (waitedMs >= POLL_TIMEOUT_MS) throw new Error('FC_REFRESH_TIMEOUT')
      await this.sleep(POLL_INTERVAL_MS)
      waitedMs += POLL_INTERVAL_MS
    }
  }

  async transactions(accountId: string): Promise<Transaction[]> {
    await this.requestRefresh(accountId)
    await this.waitForRefresh(accountId)

    const out: Transaction[] = []
    let startingAfter: string | undefined
    for (;;) {
      const url = new URL(`${FC_BASE}/transactions`)
      url.searchParams.set('account', accountId)
      url.searchParams.set('limit', '100')
      if (startingAfter) url.searchParams.set('starting_after', startingAfter)

      const response = await this.fetchFn(url.toString(), {
        method: 'GET',
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(20_000),
      })
      const json = (await response.json()) as {
        data?: unknown[]
        has_more?: boolean
        error?: { code?: string }
      }
      if (!response.ok || !json.data) {
        throw new Error(`STRIPE_${json.error?.code ?? response.status}`)
      }
      const rawRows = json.data
      for (const raw of rawRows) {
        const parsed = StripeTransactionRowSchema.safeParse(raw)
        if (!parsed.success) continue
        const row = parsed.data
        out.push({
          id: row.id,
          description: row.description,
          amountCents: -row.amount,
          postedAt: new Date(row.transacted_at * 1000).toISOString(),
          status: row.status,
        })
      }
      if (!json.has_more || rawRows.length === 0) break
      const last = rawRows[rawRows.length - 1] as { id?: unknown } | undefined
      startingAfter = typeof last?.id === 'string' ? last.id : undefined
      if (!startingAfter) break
    }
    return out
  }
}
