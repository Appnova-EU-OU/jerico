declare module 'better-sqlite3' {
  interface Statement {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
    get<T = Record<string, unknown>>(...params: unknown[]): T | undefined
    all<T = Record<string, unknown>>(...params: unknown[]): T[]
    pluck(): Statement & { get: () => unknown }
  }
  interface Database {
    prepare(sql: string): Statement
    transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T
    pragma(info: string): { foreign_keys: number } | undefined
    exec(sql: string): void
    close(): void
  }
  interface Options {
    readonly?: boolean
    timeout?: number
  }
  function DatabaseConstructor(path: string, options?: Options): Database
  export default DatabaseConstructor
}
