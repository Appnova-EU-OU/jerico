// Ambient declaration for bun:sqlite — used by the daemon at runtime.
// tsc --noEmit needs this to resolve the module.
declare module 'bun:sqlite' {
  export class Database {
    constructor(path: string, options?: { readonly?: boolean })
    query<T>(sql: string): { get(...args: unknown[]): T | null }
    close(): void
  }
}
