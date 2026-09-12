import type { tool } from '@strands-agents/sdk'
import type { SpendInputMapper } from '../gate-intervention.js'
import type { CallResult } from '../tools/phone.js'

// Shared shapes every errand module (dinner, subscription-cancel, etc.) implements.
// src/agent.ts composes a list of these into one system prompt, one tool list and
// one merged spend-tool map, without knowing anything errand-specific.

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

// What an errand hands agent.ts to actually place a call: the destination and the
// fully-built Vapi assistant body. The errand module owns building that assistant
// (its own system prompt, structured-data schema); the runner only dials it.
export type CallRunner = (args: { to: string; assistant: object }) => Promise<CallResult>

export interface ErrandModule {
  name: string
  tools: ReturnType<typeof tool>[]
  spendTools: Map<string, SpendInputMapper>
  // The numbered workflow lines for this errand, merged into the system prompt
  // under an `Errand "<name>":` heading.
  promptLines: string[]
}
