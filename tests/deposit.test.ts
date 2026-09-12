import { describe, expect, it } from 'vitest'
import { STRIPE_PAYMENT_INTENTS_URL, StripeTestDeposits } from '../src/tools/deposit.js'

describe('StripeTestDeposits', () => {
  it('refuses to run with a live key', () => {
    expect(() => new StripeTestDeposits('sk_live_abc')).toThrow('STRIPE_TEST_KEY_REQUIRED')
    expect(() => new StripeTestDeposits('')).toThrow('STRIPE_TEST_KEY_REQUIRED')
  })

  it('confirms a test-mode PaymentIntent with an idempotency key', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const deposits = new StripeTestDeposits('sk_test_abc', async (url, init) => {
      seen.push({ url, init })
      return new Response(JSON.stringify({ id: 'pi_1', status: 'succeeded', amount: 1500 }))
    })
    const receipt = await deposits.charge({
      amountCents: 1500,
      description: 'Deposit: Trattoria Roma',
      idempotencyKey: 'errand-1-deposit',
    })
    expect(receipt).toEqual({ id: 'pi_1', status: 'succeeded', amountCents: 1500 })
    expect(seen[0]?.url).toBe(STRIPE_PAYMENT_INTENTS_URL)
    const headers = seen[0]?.init.headers as Record<string, string>
    expect(headers['Idempotency-Key']).toBe('errand-1-deposit')
    const body = new URLSearchParams(String(seen[0]?.init.body))
    expect(body.get('amount')).toBe('1500')
    expect(body.get('confirm')).toBe('true')
    expect(body.get('payment_method')).toBe('pm_card_visa')
  })

  it('surfaces Stripe errors', async () => {
    const deposits = new StripeTestDeposits(
      'sk_test_abc',
      async () =>
        new Response(JSON.stringify({ error: { code: 'card_declined' } }), { status: 402 }),
    )
    await expect(
      deposits.charge({ amountCents: 1, description: 'x', idempotencyKey: 'k' }),
    ).rejects.toThrow('STRIPE_card_declined')
  })
})
