// Human copy for a spend category. The raw key (e.g. "service_booking") is a
// policy identifier, not something to show a person mid-decision. Both the
// intervention prompt and the out-of-band step-up summary must agree on the
// same wording, so this is the one place either of them may read it from.

const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  restaurant_deposit: 'restaurant deposit',
  service_booking: 'service booking',
  call: 'phone call',
}

export const categoryLabel = (category: string): string =>
  CATEGORY_LABELS[category] ?? category.replace(/_/g, ' ')

// "Maria R." already ends in a period; appending another gives "Maria R..".
// Shared by every human-facing channel that composes a name into a sentence
// (the approval prompt and the step-up summary), so a name is never
// double-punctuated on one channel while the other trims it.
export const noTrailingPeriod = (text: string): string => text.replace(/\.+$/, '')
