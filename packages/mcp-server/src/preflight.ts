export type McpPreflightResult =
  | { ok: true }
  | { ok: false; status: number; body: { error: string } }

/** Membership-only HTTP session preflight. Resource checks stay on each API call. */
export async function preflightWorkspaceMembership(
  bridgeServerUrl: string,
  workspaceId: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<McpPreflightResult> {
  const response = await fetchImpl(
    `${bridgeServerUrl.replace(/\/$/, '')}/api/workspaces/${encodeURIComponent(workspaceId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  ).catch(() => null)

  if (!response || response.status === 401) {
    return { ok: false, status: 401, body: { error: 'Invalid token or unauthorized' } }
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      body: { error: response.status === 404 ? 'Workspace not found' : 'Workspace server error' },
    }
  }
  return { ok: true }
}
