import {
  DIAG_FLAG_MAX_AGE_MS,
  diagnosticPaths,
  hookDiagnosticsEnabled,
  maintainHookDiagnostics,
  readHookDiagnosticLines,
  setHookDiagnosticsEnabled
} from '../hooks/diagnostics.js'

export interface HookDiagOptions {
  enable?: boolean
  disable?: boolean
  tail?: number
  json?: boolean
  home?: string
  write?: (line: string) => void
}

export function runHookDiag(options: HookDiagOptions = {}): void {
  const write = options.write ?? console.log
  const paths = diagnosticPaths(options.home)
  if (options.enable && options.disable) throw new Error('Choose either --enable or --disable')
  if (options.enable) setHookDiagnosticsEnabled(true, options.home)
  if (options.disable) setHookDiagnosticsEnabled(false, options.home)
  maintainHookDiagnostics({ home: options.home })

  const enabled = hookDiagnosticsEnabled(options.home)
  const lines = readHookDiagnosticLines(options.home, options.tail ?? 50)
  if (options.json) {
    write(JSON.stringify({ enabled, expiresAfterMs: DIAG_FLAG_MAX_AGE_MS, log: paths.log, lines }))
    return
  }
  if (options.enable) write(`[bridge] Hook diagnostics enabled for 30 minutes: ${paths.log}`)
  else if (options.disable) write('[bridge] Hook diagnostics disabled')
  else write(`[bridge] Hook diagnostics gate: ${enabled ? 'on (flag)' : 'off'} (enable: bridge-agent hook-diag --enable)`)
  write(`[bridge] Log: ${paths.log}`)
  for (const line of lines) write(line)
}
