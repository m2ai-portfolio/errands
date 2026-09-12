// Deposit payments. Stripe TEST MODE only: the constructor refuses a live key,
// so this code path can never move real money. The spending gate has already
// committed the charge (and a human has approved it) before charge() runs.

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface DepositCharge {
  amountCents: number
  description: string
  idempotencyKey: string
}

export interface DepositReceipt {
  id: string
  status: string
  amountCents: number
}

export interface DepositProcessor {
  charge(args: DepositCharge): Promise<DepositReceipt>
}

export const STRIPE_PAYMENT_INTENTS_URL = 'https://api.stripe.com/v1/payment_intents'

export class StripeTestDeposits implements DepositProcessor {
  constructor(
    private readonly secretKey: string,
    private readonly fetchFn: FetchLike = fetch,
  ) {
    if (!/^(sk|rk)_test_/.test(secretKey)) throw new Error('STRIPE_TEST_KEY_REQUIRED')
  }

  async charge({
    amountCents,
    description,
    idempotencyKey,
  }: DepositCharge): Promise<DepositReceipt> {
    const body = new URLSearchParams({
      amount: String(amountCents),
      currency: 'usd',
      payment_method: 'pm_card_visa',
      confirm: 'true',
      'automatic_payment_methods[enabled]': 'true',
      'automatic_payment_methods[allow_redirects]': 'never',
      description: description.slice(0, 200),
    })
    const response = await this.fetchFn(STRIPE_PAYMENT_INTENTS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': idempotencyKey,
      },
      body,
      signal: AbortSignal.timeout(20_000),
    })
    const json = (await response.json()) as {
      id?: string
      status?: string
      amount?: number
      error?: { code?: string; message?: string }
    }
    if (!response.ok || !json.id) {
      throw new Error(`STRIPE_${json.error?.code ?? response.status}`)
    }
    return {
      id: json.id,
      status: json.status ?? 'unknown',
      amountCents: json.amount ?? amountCents,
    }
  }
}
