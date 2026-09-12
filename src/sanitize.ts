// Text that reaches a human-facing prompt, a model-facing prompt, or an
// evidence string is never something Errands wrote. Merchant names trace back
// to bank transaction descriptions, tasker and shop names to a marketplace
// fixture or a search result. Before any of it enters an instruction-bearing
// prompt it is stripped down to printable, single-line, length-capped text so
// it cannot smuggle control characters (terminal CSI escapes that erase and
// rewrite the lines the human is reading) or a long injected instruction into
// the one surface the human actually reads.

const MAX_PROMPT_TEXT_LENGTH = 60

export function sanitizeForPrompt(text: string): string {
  // Strip C0/C1 control characters (includes \n, \r, \t, ESC) plus every
  // Unicode format character, line/paragraph separator, zero-width space,
  // joiner, and bidi override/isolate control (\p{Cc}\p{Cf}\p{Zl}\p{Zp}).
  // A pure C0/C1 filter let zero-width and bidi controls through unchanged,
  // letting an injected instruction survive byte-identical through this
  // filter and the length cap.
  const printableOnly = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
  const collapsed = printableOnly.replace(/\s+/g, ' ').trim()
  return collapsed.slice(0, MAX_PROMPT_TEXT_LENGTH)
}
