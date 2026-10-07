import { BridgeApiError } from './api.js'

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

export function okToolResult(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] }
}

export function errorToolResult(error: unknown): ToolResult {
  const body = error && typeof error === 'object'
    ? error
    : { ok: false, error: String(error) }
  return {
    content: [{ type: 'text', text: JSON.stringify(body) }],
    isError: true,
  }
}

/** Convert HTTP failures to MCP failures without interpreting authorization. */
export async function safeTool<T>(fn: () => Promise<T>): Promise<ToolResult> {
  try {
    return okToolResult(await fn())
  } catch (error) {
    if (error instanceof Error && (error.name === 'TypeError' || error.name === 'ReferenceError')) {
      console.error('[mcp-bridge] unexpected tool handler error', {
        name: error.name,
        message: error.message,
        stack: error.stack,
      })
    }
    return errorToolResult(error instanceof BridgeApiError ? error.body : {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
