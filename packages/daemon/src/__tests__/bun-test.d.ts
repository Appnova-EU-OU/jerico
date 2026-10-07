declare module 'bun:test' {
  export const describe: (name: string, fn: () => void) => void
  export const test: (name: string, fn: () => void | Promise<void>) => void
  export const beforeEach: (fn: () => void | Promise<void>) => void
  export const afterEach: (fn: () => void | Promise<void>) => void
  export const expect: (value: unknown) => {
    toBe: (expected: unknown) => void
    toEqual: (expected: unknown) => void
    toBeGreaterThan: (expected: number) => void
  }
  export interface Mock<T extends (...args: any[]) => any> {
    (...args: Parameters<T>): ReturnType<T>
    mockClear(): void
  }
  export const mock: {
    <T extends (...args: any[]) => any>(fn: T): Mock<T>
    module: (specifier: string, factory: () => Record<string, unknown>) => void
  }
}
