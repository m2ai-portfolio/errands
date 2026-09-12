// Bank data sources: a fixture for tests/dev, and a Stripe Financial Connections
// implementation. Stripe TEST MODE only: the constructor refuses a live key, same
// guard as deposit.ts.

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

interface FcTransaction {
  id: string
  description: string
  amount: number
  status: 'pending' | 'posted' | 'void'
  transacted_at: number
}

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
    if (!response.ok || !session.client_secret) {
      throw new Error(`STRIPE_${session.error?.code ?? response.status}`)
    }

    const accountIds = await this.collect(session.client_secret)
    const accountId = accountIds[0]
    if (!accountId) throw new Error('FC_NO_ACCOUNT_SELECTED')

    const account = await this.getAccount(accountId)
    return {
      id: account.id,
      institution: account.institution_name ?? 'Unknown',
      last4: account.last4 ?? '',
    }
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
        data?: FcTransaction[]
        has_more?: boolean
        error?: { code?: string }
      }
      if (!response.ok || !json.data) {
        throw new Error(`STRIPE_${json.error?.code ?? response.status}`)
      }
      for (const row of json.data) {
        out.push({
          id: row.id,
          description: row.description,
          amountCents: -row.amount,
          postedAt: new Date(row.transacted_at * 1000).toISOString(),
          status: row.status,
        })
      }
      if (!json.has_more || json.data.length === 0) break
      startingAfter = json.data[json.data.length - 1]!.id
    }
    return out
  }
}
