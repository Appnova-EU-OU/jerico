import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { type BridgeContext, sendAgentMessage, pollAgentMessages } from '../api.js'
import { safeTool as safe } from '../tool-result.js'

export function registerMessagingTools(server: McpServer, ctx: BridgeContext): void {
  server.tool(
    'bridge_send_message',
    'Send a message to another agent panel in this project. If toAgentId is omitted, broadcasts to all panels. ' +
    'A destructive command aimed at a shell panel (as toAgentId, or as a shell member of a broadcast) can return ' +
    '400 { ok: false, error: "blast_radius_confirmation_required", message: <reason> } — deterministic, not transient: ' +
    'resending the identical content without confirmBlastRadius will keep failing. Resend the SAME call with ' +
    'confirmBlastRadius: true to proceed; it covers only that one call (this content, these targets) and is never stored. ' +
    'On a broadcast, a shell target refused this way is reported the same way any other undelivered target is: in failedAgentIds.',
    {
      content:   z.string().min(1).describe('Message content to send to the target agent'),
      toAgentId: z.string().optional().describe('Target panel ID. Omit to broadcast to all panels.'),
      confirmBlastRadius: z.boolean().optional()
        .describe('Set true to proceed after a blast_radius_confirmation_required refusal for THIS exact content. Omit or false: the gate applies. Not stored — must be resent on every call it should cover.'),
    },
    ({ content, toAgentId, confirmBlastRadius }) => safe(() => sendAgentMessage(ctx, content, toAgentId, confirmBlastRadius)),
  )

  server.tool(
    'bridge_poll_messages',
    'Poll for messages sent to this panel from other agents. Use the returned cursor as the `since` value in your next call to get only new messages.',
    {
      since: z.number().optional().describe('Unix timestamp (ms). Only return messages newer than this. Use cursor from previous response.'),
    },
    ({ since }) => safe(() => pollAgentMessages(ctx, since)),
  )
}
