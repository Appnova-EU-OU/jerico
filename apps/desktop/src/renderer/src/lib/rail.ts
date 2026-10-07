/**
 * The setup rail, as data — kept out of the .svelte file so it can be tested
 * without a DOM. The ordinals are legitimate: setup genuinely is a sequence,
 * and the rail is the only element that answers "how much is left".
 */
export const RAIL = [
  { key: 'welcome', n: '01', label: 'Welcome' },
  { key: 'migrate', n: '02', label: 'Existing setup' },
  { key: 'auth', n: '03', label: 'Account' },
  { key: 'service-consent', n: '04', label: 'Consent' },
  { key: 'permissions', n: '05', label: 'Permissions' },
  { key: 'done', n: '06', label: 'Finish' },
] as const

export type RailKey = (typeof RAIL)[number]['key']

export type RailState = 'done' | 'current' | 'next'

/** An off-by-one here marks the step you are standing on as finished, which no
 *  type checker catches and no static review notices. */
export function railState(index: number, current: number): RailState {
  if (current < 0) return 'next'
  return index < current ? 'done' : index === current ? 'current' : 'next'
}
