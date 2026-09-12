import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

const dir = mkdtempSync(join(tmpdir(), 'errands-config-'))
const policyPath = join(dir, 'policy.json')
const demoPath = join(dir, 'demo.json')
writeFileSync(
  policyPath,
  JSON.stringify({
    enabled: true,
    perTransactionCapCents: 2000,
    dailyCapCents: 2500,
    weeklyCapCents: 4000,
    approvalTtlMinutes: 30,
    stepUpCents: 1000,
    promoteAfter: 3,
    notifyCapCents: { restaurant_deposit: 500 },
    vetting: {
      minRating: 4.7,
      minJobs: 50,
      requireBackgroundCheck: true,
      requireInsuredFor: { vehicle: true },
      phoneScreenRequired: true,
    },
    counterparties: {},
    categories: { call: 'allow', restaurant_deposit: 'confirm' },
  }),
)
writeFileSync(
  demoPath,
  JSON.stringify({
    outboundPhoneNumberId: 'pn-out',
    lines: [
      { role: 'open', phoneNumberId: 'pn-open', number: '+15025550101' },
      { role: 'full', phoneNumberId: 'pn-full', number: '+15025550100' },
    ],
  }),
)
const paths = { policy: policyPath, demo: demoPath }

describe('loadConfig', () => {
  it('defaults to demo mode and orders demo lines full first, then open', () => {
    const config = loadConfig({ VAPI_API_KEY: 'k' }, paths)
    expect(config.mode).toBe('demo')
    expect(config.demoLines).toEqual(['+15025550100', '+15025550101'])
    expect(config.outboundPhoneNumberId).toBe('pn-out')
  })

  it('falls back to fixture search without a Google key', () => {
    expect(loadConfig({ VAPI_API_KEY: 'k' }, paths).searchSource).toBe('fixture')
    expect(loadConfig({ VAPI_API_KEY: 'k', GOOGLE_API_KEY: 'g' }, paths).searchSource).toBe(
      'google-places',
    )
    expect(
      loadConfig({ VAPI_API_KEY: 'k', GOOGLE_API_KEY: 'g', ERRANDS_SEARCH: 'fixture' }, paths)
        .searchSource,
    ).toBe('fixture')
  })

  it('reads the Bedrock region and model from the environment', () => {
    const config = loadConfig(
      { VAPI_API_KEY: 'k', AWS_REGION: 'us-west-2', BEDROCK_MODEL_ID: 'm' },
      paths,
    )
    expect(config.bedrock).toEqual({ region: 'us-west-2', modelId: 'm' })
  })

  it('parses the live allowlist', () => {
    const config = loadConfig(
      { VAPI_API_KEY: 'k', ERRANDS_MODE: 'live', ERRANDS_LIVE_ALLOWLIST: '+16155550100, +1615' },
      paths,
    )
    expect(config.mode).toBe('live')
    expect(config.liveAllowlist).toEqual(['+16155550100', '+1615'])
  })

  it('refuses to start without a Vapi key or with an invalid policy', () => {
    expect(() => loadConfig({}, paths)).toThrow('CONFIG_MISSING_VAPI_API_KEY')
    const bad = join(dir, 'bad-policy.json')
    writeFileSync(bad, JSON.stringify({ enabled: 'yes' }))
    expect(() => loadConfig({ VAPI_API_KEY: 'k' }, { ...paths, policy: bad })).toThrow()
  })

  it('exposes demo lines by role and defaults the switchboard to null', () => {
    const config = loadConfig({ VAPI_API_KEY: 'k' }, paths)
    expect(config.demoLinesByRole.full).toBe('+15025550100')
    expect(config.demoLinesByRole.open).toBe('+15025550101')
    expect(config.demoLinesByRole.switchboard).toBeNull()
  })

  it('loads a switchboard line when present', () => {
    const demoWithSwitchboardPath = join(dir, 'demo-switchboard.json')
    writeFileSync(
      demoWithSwitchboardPath,
      JSON.stringify({
        outboundPhoneNumberId: 'pn-out',
        lines: [
          { role: 'open', phoneNumberId: 'pn-open', number: '+15025550101' },
          { role: 'full', phoneNumberId: 'pn-full', number: '+15025550100' },
          { role: 'switchboard', phoneNumberId: 'pn-sw', number: '+15025550102' },
        ],
      }),
    )
    const pathsWithSwitchboard = { ...paths, demo: demoWithSwitchboardPath }
    expect(
      loadConfig({ VAPI_API_KEY: 'k' }, pathsWithSwitchboard).demoLinesByRole.switchboard,
    ).toBe('+15025550102')
  })

  it('defaults step-up to console and LAN host to 10.0.0.46', () => {
    const config = loadConfig({ VAPI_API_KEY: 'k' }, paths)
    expect(config.stepUpChannel).toBe('console')
    expect(config.lanHost).toBe('10.0.0.46')
  })

  it('selects telegram step-up only when both token and chat id are present', () => {
    expect(
      loadConfig(
        {
          VAPI_API_KEY: 'k',
          ERRANDS_STEPUP: 'telegram',
          TELEGRAM_BOT_TOKEN: 't',
          TELEGRAM_CHAT_ID: 'c',
        },
        paths,
      ).stepUpChannel,
    ).toBe('telegram')
    expect(loadConfig({ VAPI_API_KEY: 'k', ERRANDS_STEPUP: 'telegram' }, paths).stepUpChannel).toBe(
      'console',
    )
  })

  it('uses the fixture bank unless a publishable key and ERRANDS_BANK=stripe are set', () => {
    expect(loadConfig({ VAPI_API_KEY: 'k' }, paths).bankSource).toBe('fixture')
    expect(
      loadConfig(
        {
          VAPI_API_KEY: 'k',
          ERRANDS_BANK: 'stripe',
          STRIPE_PUBLISHABLE_KEY: 'pk_test_x',
          STRIPE_SECRET_KEY: 'sk_test_x',
        },
        paths,
      ).bankSource,
    ).toBe('stripe')
  })

  it('rejects a policy whose notify cap is at or above stepUpCents', () => {
    const badCapPath = join(dir, 'policy-notify-cap-too-high.json')
    writeFileSync(
      badCapPath,
      JSON.stringify({
        enabled: true,
        perTransactionCapCents: 10000,
        dailyCapCents: 15000,
        weeklyCapCents: 25000,
        approvalTtlMinutes: 30,
        stepUpCents: 5000,
        promoteAfter: 3,
        notifyCapCents: { service_booking: 5000 },
        vetting: {
          minRating: 4.7,
          minJobs: 50,
          requireBackgroundCheck: true,
          requireInsuredFor: { vehicle: true },
          phoneScreenRequired: true,
        },
        counterparties: {},
        categories: { call: 'allow', service_booking: 'confirm' },
      }),
    )
    expect(() => loadConfig({ VAPI_API_KEY: 'k' }, { ...paths, policy: badCapPath })).toThrow(
      'NOTIFY_CAP_MUST_BE_BELOW_STEP_UP',
    )
  })

  it('defaults promoteHumanAfter to 1 when the policy file omits it', () => {
    const config = loadConfig({ VAPI_API_KEY: 'k' }, paths)
    expect(config.policy.promoteHumanAfter).toBe(1)
  })

  it('rejects a policy missing the trust fields', () => {
    const incompletePolicyPath = join(dir, 'policy-missing-trust-fields.json')
    writeFileSync(
      incompletePolicyPath,
      JSON.stringify({
        enabled: true,
        perTransactionCapCents: 10000,
        dailyCapCents: 15000,
        weeklyCapCents: 25000,
        approvalTtlMinutes: 30,
        promoteAfter: 3,
        notifyCapCents: { restaurant_deposit: 2500, service_booking: 5000 },
        vetting: {
          minRating: 4.7,
          minJobs: 50,
          requireBackgroundCheck: true,
          requireInsuredFor: { vehicle: true },
          phoneScreenRequired: true,
        },
        counterparties: {},
        categories: {
          call: 'allow',
          restaurant_deposit: 'confirm',
          service_booking: 'confirm',
          hire: 'confirm',
          cancellation: 'confirm',
          gift: 'forbid',
        },
      }),
    )
    expect(() =>
      loadConfig({ VAPI_API_KEY: 'k' }, { ...paths, policy: incompletePolicyPath }),
    ).toThrow()
  })
})
