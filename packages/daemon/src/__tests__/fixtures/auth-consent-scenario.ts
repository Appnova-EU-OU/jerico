import { mock } from 'bun:test'

mock.module('../../token-store.js', () => ({
  getToken: () => ({ found: false, token: null, source: 'none' as const }),
  keychainHasToken: () => false,
  setToken: () => 'keychain' as const,
}))

class AuthExit extends Error {
  constructor(readonly code: number) {
    super(`auth exited ${String(code)}`)
  }
}

const realExit = process.exit.bind(process)
const interactive = process.env['AUTH_SCENARIO_TTY'] === '1'
Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: interactive })
process.exit = ((code?: number): never => {
  throw new AuthExit(code ?? 0)
}) as typeof process.exit

const { runAuth } = await import('../../commands/auth.js')

try {
  await runAuth(
    process.env['AUTH_SCENARIO_SERVER'],
    true,
    process.env['AUTH_SCENARIO_TOKEN'],
    process.env['AUTH_SCENARIO_DAEMON_SERVER'],
  )
  realExit(97)
} catch (err) {
  if (err instanceof AuthExit) {
    realExit(err.code)
  }
  console.error(err)
  realExit(98)
}
