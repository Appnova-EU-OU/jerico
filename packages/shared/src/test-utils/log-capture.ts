export interface LogEntry {
  msg: string
  data?: unknown
}

export interface LogCapture {
  warns: LogEntry[]
  errors: LogEntry[]
  logs: LogEntry[]
  restore: () => void
}

export function captureLogs(): LogCapture {
  const warns: LogEntry[] = []
  const errors: LogEntry[] = []
  const logs: LogEntry[] = []
  const origWarn = console.warn
  const origError = console.error
  const origLog = console.log

  console.warn = (msg: unknown, data?: unknown) => {
    warns.push({ msg: String(msg), data })
  }
  console.error = (msg: unknown, data?: unknown) => {
    errors.push({ msg: String(msg), data })
  }
  console.log = (msg: unknown, data?: unknown) => {
    logs.push({ msg: String(msg), data })
  }

  return {
    warns,
    errors,
    logs,
    restore: () => {
      console.warn = origWarn
      console.error = origError
      console.log = origLog
    },
  }
}
