# Errands

**An AI agent, built with the [Strands Agents SDK](https://strandsagents.com), that books dinner for you end to end and only interrupts you when money is involved.**

Entry for the [Agents for Humans Hackathon](https://agentsforhumans.devpost.com), Everyday Agents track.

## The problem

Booking a table tonight is a small errand that eats 20 minutes: look up the place, call, get told they are full, find something comparable, call again, hand over a card for a deposit. Every step is easy. Together they are exactly the kind of busywork people put off, and "just use an app" does not help when the restaurant only takes phone calls or wants a deposit.

## Who it is for

Busy people who would happily hand the whole errand to an assistant if they could trust it: parents coordinating a night out, professionals who cannot make calls during the day, anyone who has ever said "can you just book something nice for 7?"

## Why it matters

An assistant that can spend money has to be trustworthy by construction, not by prompt. Errands runs in the background, makes the safe calls on its own (searching, phoning, falling back to a comparable restaurant) and surfaces for exactly one thing: a decision that moves money. That decision is enforced in code, not left to the model.

## What it does

```
You:  "Book dinner for 2 tonight at 7 at Bella Cucina in Nashville.
       If they're full, find somewhere comparable between 6:30 and 8."

Errands:
  · search "Bella Cucina Nashville" -> Bella Cucina, ...
  · calling Bella Cucina (attempt 1)          <- real AI voice call
  · Bella Cucina: not booked                   "fully booked tonight"
  · search "italian Nashville" (excluding Bella Cucina) -> Trattoria Roma
  · calling Trattoria Roma (attempt 2)
  · Trattoria Roma: booked 7:00 PM            deposit $15 required

>>> DECISION NEEDED: Errands wants to spend $15.00 (restaurant_deposit)
    at Trattoria Roma. Approve? [y/N] y

  · deposit succeeded: Trattoria Roma
"Booked: Trattoria Roma, 7:00 PM, party of 2, confirmation TR-4821,
 $15 deposit paid. Bella Cucina was full. Reply 'cancel' to release it."
```

## How it works

- **Strands Agents SDK (TypeScript)** runs the agent loop on **Claude Sonnet 4.6 via Amazon Bedrock**, with three tools:
  - `search_restaurants`: Google Places (New) Text Search, or a fixture list offline.
  - `call_restaurant`: places a real outbound AI phone call through [Vapi](https://vapi.ai). The caller says it is an AI assistant, asks for the table and any deposit, and never gives out payment details. The call's structured outcome (booked, time, confirmation, deposit) comes back to the agent.
  - `pay_deposit`: charges the quoted deposit (Stripe, test mode only).
- **A spending gate enforced in two places** (`src/gate.ts`, `src/gate-intervention.ts`):
  1. A Strands **intervention** runs before every tool call. Forbidden spend is denied, "confirm" spend pauses for the human, and the one-time approval code is injected by the intervention after the human says yes. Any code the model invents is thrown away.
  2. The tool itself calls `gate.commit()`, which re-checks the policy (per-transaction, rolling 24-hour and 7-day caps, kill switch) and refuses confirm-category spend without a valid single-use code bound to merchant, amount and category.
- **Deterministic guardrails around the model**: the model passes restaurant ids, never phone numbers; the deposit must equal the amount the restaurant quoted on a booked call (checked before the human is asked); at most 3 calls per errand; the policy lives in `policy.json` for anyone to read.

## Safety in demo mode

Judges can run this, so everything public runs sandboxed:

- **No real business is ever called.** In demo mode, `call_restaurant` routes every call to two test phone lines we control: the first plays a restaurant that is fully booked, the second one that has a table and requires a $15 deposit. Search still returns real restaurants so you can see the agent choose. Live mode only dials numbers on an explicit allowlist.
- **No real money moves.** Deposits use Stripe **test mode**; the code refuses to start with a live key.

## Run it

Requirements: Node.js 22+, an AWS account with Bedrock access to Claude Sonnet 4.6 (a Bedrock API key or an IAM key pair), a Vapi account with an outbound number and two demo lines, a Stripe test key, and optionally a Google Maps key with Places API (New).

```bash
git clone https://github.com/m2ai-portfolio/errands && cd errands
npm install
npm test                                   # 51 offline tests, no keys needed

export AWS_REGION=us-east-1 AWS_BEARER_TOKEN_BEDROCK=...   # a Bedrock API key; an IAM key pair works too
export VAPI_API_KEY=... STRIPE_SECRET_KEY=sk_test_...
export GOOGLE_API_KEY=...                  # optional; without it search uses fixtures/
mkdir -p ~/.config/errands && cp demo.example.json ~/.config/errands/demo.json   # then fill in your Vapi ids

npm start -- "Book dinner for 2 tonight at 7 at Bella Cucina in Nashville, or somewhere comparable"
```

Configuration: `ERRANDS_MODE` (`demo` default, or `live`), `ERRANDS_LIVE_ALLOWLIST`, `ERRANDS_SEARCH=fixture`, `ERRANDS_CUSTOMER_NAME`, `BEDROCK_MODEL_ID` (default `global.anthropic.claude-sonnet-4-6`), `ERRANDS_POLICY`, `ERRANDS_DEMO_CONFIG`.

## Project layout

| Path                        | What it is                                                    |
| --------------------------- | ------------------------------------------------------------- |
| `src/agent.ts`              | Strands Agent, tools and the deterministic checks around them |
| `src/gate.ts`               | Spending policy, caps, kill switch, approval codes, ledger    |
| `src/gate-intervention.ts`  | Strands intervention that forces every spend through the gate |
| `src/tools/phone.ts`        | Vapi calls, demo-line routing, the reservation call script    |
| `src/tools/restaurants.ts`  | Google Places and fixture search                              |
| `src/tools/deposit.ts`      | Stripe test-mode deposits                                     |
| `tests/errand-flow.test.ts` | Offline end-to-end run: full, fallback, human approval        |

## Prior work disclosure

This repository was created and written during the hackathon Submission Period (from September 11, 2026). Before that, the author prototyped an "errands" skill for his personal assistant agent (a private, differently licensed codebase built on a different agent framework): a spending-gate command-line tool, a phone-call helper, and seven example errands mapped on paper. None of that code is included here. The design lessons carried over, and the weaknesses found in that prototype (the gate was not enforced in code, approval codes were too short and not bound to a category, the ledger was self-reported) are what this rebuild fixes.

## License

Apache License 2.0. See [LICENSE](LICENSE).
