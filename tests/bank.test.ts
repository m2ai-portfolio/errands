import { describe, expect, it } from 'vitest'
import { FC_BASE, FixtureBank, StripeFinancialConnections } from '../src/tools/bank.js'
import type { Transaction } from '../src/tools/recurring.js'

describe('FixtureBank', () => {
  const rows: Transaction[] = [
    {
      id: 't1',
      description: 'Netflix',
      amountCents: 1599,
      postedAt: '2026-01-01T00:00:00.000Z',
      status: 'posted',
    },
  ]

  it('connect() returns the fixture account', async () => {
    const bank = new FixtureBank(rows)
    expect(bank.source).toBe('fixture')
    await expect(bank.connect()).resolves.toEqual({
      id: 'fixture-checking',
      institution: 'Demo Bank',
      last4: '0000',
    })
  })

  it('transactions() returns the configured rows', async () => {
    const bank = new FixtureBank(rows)
    await expect(bank.transactions('fixture-checking')).resolves.toEqual(rows)
  })
})

describe('StripeFinancialConnections', () => {
  it('refuses to run with a live key', () => {
    expect(
      () =>
        new StripeFinancialConnections({
          secretKey: 'sk_live_abc',
          customerId: 'cus_1',
          collect: async () => ['fca_1'],
        }),
    ).toThrow('STRIPE_TEST_KEY_REQUIRED')
  })

  it('connect() creates a session with transactions-only permissions and calls collect', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const fc = new StripeFinancialConnections({
      secretKey: 'sk_test_abc',
      customerId: 'cus_1',
      collect: async (clientSecret) => {
        expect(clientSecret).toBe('fcsess_client_secret_1')
        return ['fca_1']
      },
      fetchFn: async (url, init) => {
        seen.push({ url: String(url), init })
        if (String(url) === `${FC_BASE}/sessions`) {
          return new Response(
            JSON.stringify({ id: 'fcsess_1', client_secret: 'fcsess_client_secret_1' }),
          )
        }
        if (String(url) === `${FC_BASE}/accounts/fca_1`) {
          return new Response(
            JSON.stringify({
              id: 'fca_1',
              institution_name: 'Test Bank',
              last4: '6789',
              transaction_refresh: { status: 'succeeded' },
            }),
          )
        }
        throw new Error(`unexpected url ${String(url)}`)
      },
    })

    const account = await fc.connect()
    expect(account).toEqual({ id: 'fca_1', institution: 'Test Bank', last4: '6789' })

    const sessionCall = seen.find((c) => c.url === `${FC_BASE}/sessions`)
    expect(sessionCall).toBeDefined()
    const body = new URLSearchParams(String(sessionCall?.init.body))
    expect(body.get('permissions[]')).toBe('transactions')
    expect(body.get('prefetch[]')).toBe('transactions')
    expect(body.get('account_holder[type]')).toBe('customer')
    expect(body.get('account_holder[customer]')).toBe('cus_1')
    expect(String(sessionCall?.init.body)).not.toContain('balances')
    const headers = sessionCall?.init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer sk_test_abc')
  })

  it('transactions() refreshes, polls, paginates, and maps debits to positive amountCents', async () => {
    const calls: string[] = []
    let refreshChecks = 0
    const fc = new StripeFinancialConnections({
      secretKey: 'sk_test_abc',
      customerId: 'cus_1',
      collect: async () => ['fca_1'],
      sleep: async () => {},
      fetchFn: async (url, init) => {
        const u = String(url)
        calls.push(u)
        if (u === `${FC_BASE}/accounts/fca_1/refresh`) {
          return new Response(JSON.stringify({ id: 'fca_1' }))
        }
        if (u === `${FC_BASE}/accounts/fca_1`) {
          refreshChecks += 1
          const status = refreshChecks < 2 ? 'pending' : 'succeeded'
          return new Response(
            JSON.stringify({
              id: 'fca_1',
              institution_name: 'Test Bank',
              last4: '6789',
              transaction_refresh: { status },
            }),
          )
        }
        if (u === `${FC_BASE}/transactions?account=fca_1&limit=100`) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: 'txn_1',
                  description: 'Coffee Shop',
                  amount: 500,
                  status: 'posted',
                  transacted_at: 1735689600,
                },
              ],
              has_more: true,
            }),
          )
        }
        if (u === `${FC_BASE}/transactions?account=fca_1&limit=100&starting_after=txn_1`) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: 'txn_2',
                  description: 'Refund',
                  amount: -200,
                  status: 'posted',
                  transacted_at: 1735776000,
                },
              ],
              has_more: false,
            }),
          )
        }
        throw new Error(`unexpected url ${u} ${String(init?.method)}`)
      },
    })

    const txns = await fc.transactions('fca_1')
    expect(calls).toContain(`${FC_BASE}/accounts/fca_1/refresh`)
    expect(calls).toContain(`${FC_BASE}/transactions?account=fca_1&limit=100&starting_after=txn_1`)
    expect(txns).toEqual([
      {
        id: 'txn_1',
        description: 'Coffee Shop',
        amountCents: -500,
        postedAt: new Date(1735689600 * 1000).toISOString(),
        status: 'posted',
      },
      {
        id: 'txn_2',
        description: 'Refund',
        amountCents: 200,
        postedAt: new Date(1735776000 * 1000).toISOString(),
        status: 'posted',
      },
    ])
  })

  it('tolerates a 400 from refresh when transaction_refresh is already succeeded', async () => {
    const fc = new StripeFinancialConnections({
      secretKey: 'sk_test_abc',
      customerId: 'cus_1',
      collect: async () => ['fca_1'],
      sleep: async () => {},
      fetchFn: async (url) => {
        const u = String(url)
        if (u === `${FC_BASE}/accounts/fca_1/refresh`) {
          return new Response(JSON.stringify({ error: { code: 'rate_limited' } }), { status: 400 })
        }
        if (u === `${FC_BASE}/accounts/fca_1`) {
          return new Response(
            JSON.stringify({
              id: 'fca_1',
              institution_name: 'Test Bank',
              last4: '6789',
              transaction_refresh: { status: 'succeeded' },
            }),
          )
        }
        if (u === `${FC_BASE}/transactions?account=fca_1&limit=100`) {
          return new Response(JSON.stringify({ data: [], has_more: false }))
        }
        throw new Error(`unexpected url ${u}`)
      },
    })
    await expect(fc.transactions('fca_1')).resolves.toEqual([])
  })

  it('throws FC_REFRESH_FAILED when the refresh status is failed', async () => {
    const fc = new StripeFinancialConnections({
      secretKey: 'sk_test_abc',
      customerId: 'cus_1',
      collect: async () => ['fca_1'],
      sleep: async () => {},
      fetchFn: async (url) => {
        const u = String(url)
        if (u === `${FC_BASE}/accounts/fca_1/refresh`) {
          return new Response(JSON.stringify({ id: 'fca_1' }))
        }
        if (u === `${FC_BASE}/accounts/fca_1`) {
          return new Response(
            JSON.stringify({
              id: 'fca_1',
              institution_name: 'Test Bank',
              last4: '6789',
              transaction_refresh: { status: 'failed' },
            }),
          )
        }
        throw new Error(`unexpected url ${u}`)
      },
    })
    await expect(fc.transactions('fca_1')).rejects.toThrow('FC_REFRESH_FAILED')
  })

  it('throws FC_REFRESH_TIMEOUT after 120s of pending polling', async () => {
    let elapsedMs = 0
    const fc = new StripeFinancialConnections({
      secretKey: 'sk_test_abc',
      customerId: 'cus_1',
      collect: async () => ['fca_1'],
      sleep: async (ms) => {
        elapsedMs += ms
      },
      fetchFn: async (url) => {
        const u = String(url)
        if (u === `${FC_BASE}/accounts/fca_1/refresh`) {
          return new Response(JSON.stringify({ id: 'fca_1' }))
        }
        if (u === `${FC_BASE}/accounts/fca_1`) {
          if (elapsedMs > 120_000) {
            throw new Error('should have timed out before this many polls')
          }
          return new Response(
            JSON.stringify({
              id: 'fca_1',
              institution_name: 'Test Bank',
              last4: '6789',
              transaction_refresh: { status: 'pending' },
            }),
          )
        }
        throw new Error(`unexpected url ${u}`)
      },
    })
    await expect(fc.transactions('fca_1')).rejects.toThrow('FC_REFRESH_TIMEOUT')
  })
})
