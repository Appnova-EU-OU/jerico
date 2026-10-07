// Re-export shared primitives from @jerico/shared to eliminate duplication.
// Daemon-specific message types remain local because they are a narrower subset
// than the server/web message unions.
export * from '@jerico/shared'

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Message Types (Daemon ←→ Server) — local subset
// ─────────────────────────────────────────────────────────────────────────────

/** Messages sent from server to daemon (client from daemon's perspective) */
export type ClientMessage =
  | { type: 'daemon_registered' }
  | { type: 'scheduled_cleanup_remove'; daemonId: string; requestId: string; removal: import('@jerico/shared').ScheduledWorktreeRemoval }
  | { type: 'scheduled_cleanup_status'; daemonId: string; requestId: string; operationId: string }
  | { type: 'scheduled_cleanup_probe'; daemonId: string; requestId: string; attempts?: Array<{ agentId: string; spawnAttemptId: string }>; agentIds?: string[] }
  | { type: 'spawn'; agentId: string; daemonId: string; spawnAttemptId?: import('@jerico/shared').SpawnAttemptId; agentKey: string; cols: number; rows: number; model?: string; sessionId?: string; projectId?: string; workspaceId?: string; cwd?: string; daemonLocalPath?: string | null; daemonBindingSetVia?: string | null; scheduledDutyV1?: import('@jerico/shared').ScheduledDutyV1Launch; role?: string; runnerCmd?: string; orchestratorOwned?: boolean; groupId?: string; personaId?: string; systemPrompt?: string }
  | { type: 'spawn_cancel'; agentId: string; daemonId: string; spawnAttemptId: import('@jerico/shared').SpawnAttemptId }
  // `notice: true` marks server-composed orchestration NOTICES, as opposed to
  // task payload. Only notices are held by the prompt gate (#616 layer 2): a
  // dispatch to a worker interrupts nobody's typing, and delaying it would slow
  // every run down to fix a problem it does not have.
  | { type: 'input'; agentId: string; daemonId: string; data: string; source?: 'user' | 'orchestrator'; ownsSubmit?: boolean; dispatchId?: string; panelInstanceId?: number; replay?: boolean; notice?: boolean }
  | { type: 'kill'; agentId: string; daemonId: string; force: boolean }
  | { type: 'resize'; agentId: string; daemonId: string; cols: number; rows: number }
  | { type: 'detect_agents'; daemonId?: string }
  | { type: 'detect_dev_servers'; daemonId: string; requestId: string }
  | { type: 'media_preview'; daemonId: string; agentId: string; requestId: string; cwd: string; path: string }
  | { type: 'dir_list'; daemonId: string; requestId: string; path: string }
  | { type: 'file_read'; daemonId: string; requestId: string; path: string; cwd: string; from?: 'start' | 'end' }
  | { type: 'file_write'; daemonId: string; requestId: string; path: string; cwd: string; content: string; baseMtime?: number }
  | { type: 'image_drop'; daemonId: string; requestId: string; cwd: string; filename: string; mime: string; data: string; sizeBytes: number }
  | { type: 'git_diff'; daemonId: string; requestId: string; cwd: string; path?: string; baseRef?: string }
  | { type: 'list_dir'; daemonId: string; requestId: string; cwd: string; path: string }
  | { type: 'project_tree'; daemonId: string; requestId: string; projectId?: string; cwd?: string; daemonLocalPath?: string | null }
  | { type: 'git_status'; daemonId: string; requestId: string; cwd: string }
  | { type: 'claude_sessions_list'; daemonId: string; requestId: string; cwd: string; agentKeys?: Array<'claude' | 'codex'> }
  | { type: 'claude_session_rename'; daemonId: string; cwd: string; sessionId: string; title: string; requestId: string; agentKey?: 'claude' | 'codex' }
  | { type: 'sim_tap'; agentId: string; daemonId: string; x: number; y: number }
  | { type: 'sim_swipe'; agentId: string; daemonId: string; x1: number; y1: number; x2: number; y2: number; duration?: number }
  | { type: 'sim_key'; agentId: string; daemonId: string; key: string }
  | { type: 'sim_button'; agentId: string; daemonId: string; button: 'HOME' | 'LOCK' | 'SIDE_BUTTON' | 'SIRI' | 'APPLE_PAY' }
  | { type: 'sim_get_source'; agentId: string; daemonId: string }
  | { type: 'sim_subscribe'; agentId: string; daemonId: string; spawnAttemptId: import('@jerico/shared').SpawnAttemptId }
  | { type: 'sim_unsubscribe'; agentId: string; daemonId: string; spawnAttemptId: import('@jerico/shared').SpawnAttemptId }
  | { type: 'sim_healthcheck'; agentId: string; daemonId: string }
  | { type: 'sim_install_run'; agentId: string; daemonId: string; spawnAttemptId: import('@jerico/shared').SpawnAttemptId }
  | { type: 'sim_install_cancel'; agentId: string; daemonId: string; spawnAttemptId: import('@jerico/shared').SpawnAttemptId }
  | { type: 'persona_apply'; agentId: string; personaId: string; systemPrompt?: string }
  | { type: 'role_apply'; agentId: string; role: import('@jerico/shared').AgentRole }
  | { type: 'permissions_changed'; agentId: string; capabilitiesVersion: number }
  // Issue #84: keep in lockstep with the same variant in packages/shared/src/types.ts.
  | { type: 'watch_artifact_check'; requestId: string; agentId: string; cwd: string; path: string; taskSuffix?: string; notBeforeAgeMs: number; includeRecentChanges?: boolean; changedSinceAgeMs?: number }
  | { type: 'prepare_completion_evidence'; requestId: string; completionId: string; agentId: string; panelInstanceId: number; expectedMarker: string; taskKind: import('@jerico/shared').CompletionEvidenceTaskKind }
  | { type: 'check_completion_evidence'; requestId: string; completionId: string; agentId: string; panelInstanceId: number }
  | { type: 'seal_completion_evidence'; requestId: string; completionId: string; agentId: string; panelInstanceId: number; outcome: import('@jerico/shared').CompletionOutcome; failureCode?: import('@jerico/shared').CompletionFailureCode }
  | { type: 'release_completion_evidence'; completionId: string; agentId: string; panelInstanceId: number }
  // Issue #85: keep in lockstep with the same variant in packages/shared/src/types.ts.
  | { type: 'send_keys'; requestId: string; agentId: string; daemonId: string; keys: import('@jerico/shared').SendKey[] }
  | { type: 'set_model'; agentId: string; daemonId: string; model: string }
  | { type: 'set_daemon_settings'; daemonId: string; patch: { claudeTier?: 'free' | 'pro' | 'max_5x' | 'max_20x' } }
  | { type: 'codegraph_query'; requestId: string; op: string; cwd: string; params: Record<string, unknown> }
  | { type: 'inspect_result'; daemonId: string; paneId: string; requestId: string; payload: import('@jerico/shared').InspectPayload; cwd?: string; targetAgentId?: string }
  | { type: 'preview_proxy_start'; paneId: string; daemonId: string; devUrl: string; denyOrigins?: string[] }
  | { type: 'preview_proxy_stop'; paneId: string; daemonId: string }

/** Messages sent from daemon to server */
export type ServerMessage =
  | { type: 'output'; agentId: string; data: string }
  | { type: 'exit'; agentId: string; spawnAttemptId?: import('@jerico/shared').SpawnAttemptId; exitCode: number | null; signal: string | null }
  | { type: 'agents'; daemonId: string; list: import('@jerico/shared').AgentInfo[] }
  | { type: 'ready'; version: string; name?: string; spawnHelperBroken?: boolean; ptyHealth?: import('@jerico/shared').PtyHealthInfo; protectedFoldersReadable?: boolean; capabilities?: import('@jerico/shared').ProtocolCapabilities }
  | { type: 'error'; code: string; message: string; agentId?: string; spawnAttemptId?: import('@jerico/shared').SpawnAttemptId; existingAgentId?: string; udid?: string }
  | { type: 'session_started'; agentId: string; spawnAttemptId?: import('@jerico/shared').SpawnAttemptId; sessionId: string }
  | { type: 'spawn_cancelled'; agentId: string; daemonId: string; spawnAttemptId: import('@jerico/shared').SpawnAttemptId; outcome: 'prevented' | 'killed' | 'already_cancelled' }
  | { type: 'dir_list_result'; requestId: string; path: string; entries: import('@jerico/shared').DirEntry[] }
  | { type: 'file_read_result'; requestId: string; path: string; content: string; truncated: boolean; truncatedFrom?: 'start' | 'end'; size?: number; mtime?: number; error?: string }
  | { type: 'file_write_result'; requestId: string; path: string; ok: boolean; mtime?: number; error?: string }
  | { type: 'watch_artifact_check_result'; requestId: string; agentId: string; verified: boolean; sentinel?: string; error?: 'invalid_cwd' | 'path_denied' | 'not_found' | 'stale' | 'settling' | 'read_failed'; changedEntries?: Array<{ path: string; ageMs: number }>; changedEntryCount?: number; changedEntryScanTruncated?: boolean }
  | { type: 'prepare_completion_evidence_result'; requestId: string; completionId: string; agentId: string; panelInstanceId: number; ok: boolean; path?: string; error?: import('@jerico/shared').CompletionEvidencePrepareError }
  | { type: 'check_completion_evidence_result'; requestId: string; completionId: string; agentId: string; panelInstanceId: number; verified: boolean; record?: import('@jerico/shared').CompletionEvidenceRecord; error?: import('@jerico/shared').CompletionEvidenceCheckError }
  | { type: 'seal_completion_evidence_result'; requestId: string; completionId: string; agentId: string; panelInstanceId: number; sealed: boolean; record?: import('@jerico/shared').CompletionEvidenceRecord; error?: import('@jerico/shared').CompletionEvidenceSealError }
  | { type: 'send_keys_result'; requestId: string; agentId: string; ok: boolean; error?: 'panel_not_found' | 'not_interactive_agent' | 'write_failed' }
  | { type: 'agent_hook_event'; protocolVersion: number; eventId: string; agentId: string; panelInstanceId: number; agentKey: import('@jerico/shared').AgentKey; event: 'turn_ended' | 'turn_failed'; providerSessionId?: string }
  | { type: 'panel_hook_state'; agentId: string; panelInstanceId: number; configState: import('@jerico/shared').PanelHookConfigState; hookInstallRefused?: import('@jerico/shared').HookInstallRefusal }
  | { type: 'panel_startup_gate_state'; agentId: string; panelInstanceId: number; state: import('@jerico/shared').PanelStartupGateState }
  | { type: 'image_drop_result'; requestId: string; ok: boolean; relPath?: string; error?: string }
  | { type: 'git_diff_result'; requestId: string; diff: string; error?: string }
  | { type: 'list_dir_result'; requestId: string; path: string; entries: import('@jerico/shared').TreeEntry[]; error?: string }
  | { type: 'project_tree_result'; requestId: string; cwd: string; tree: string; error?: string }
  | { type: 'git_status_result'; requestId: string; files: import('@jerico/shared').GitStatusEntry[]; error?: string }
  | { type: 'claude_sessions_result'; requestId: string; cwd: string; entries: import('@jerico/shared').ClaudeSessionEntry[]; truncated?: boolean; truncatedReason?: 'cap' | 'deadline'; error?: string }
  | { type: 'panel_token_usage'; agentId: string; usedPct: number; usedTokens: number; prompts5h?: number; limit5h?: number; resetAt?: number; tier?: string; inputTokens?: number; cacheCreationTokens?: number; cacheReadTokens?: number; outputTokens?: number; reset?: boolean }
  | { type: 'panel_codegraph_usage'; agentId: string; codegraph: number; nativeSearch: number; other: number }
  // Cohort step 3 (Fork 5): ONE final whole-transcript parse per panel, sent at
  // panel exit over ALL retained session segments. Server-consumed only (it
  // persists one codegraph_ab_results row) — never forwarded to browsers.
  | { type: 'panel_codegraph_ab_result'; agentId: string; sessionId: string; stats: { input: number; cacheCreation: number; cacheRead: number; output: number; turns: number; codegraphCalls: number; nativeSearchCalls: number; otherCalls: number; hadCompaction: boolean; anomalyCount: number; truncatedTail: boolean } }
  | { type: 'system_metrics'; daemonId: string; cpu: number; ramUsedMb: number; ramTotalMb: number }
  | { type: 'sim_frame'; agentId: string; image: string; width?: number; height?: number }
  | { type: 'sim_source'; agentId: string; source: string }
  | { type: 'sim_health'; agentId: string; checks: import('@jerico/shared').SimHealthCheck[] }
  | { type: 'sim_install_progress'; agentId: string; spawnAttemptId: import('@jerico/shared').SpawnAttemptId; step?: 'pre_check' | 'xcode_install' | 'brew_check' | 'idb_install' | 'sim_boot' | 'done' | 'error'; stream?: 'stdout' | 'stderr'; line?: string; exitCode?: number; error?: string }
  | { type: 'daemon_settings_updated'; daemonId: string; claudeTier?: 'free' | 'pro' | 'max_5x' | 'max_20x'; ok: boolean; error?: string }
  | { type: 'codegraph_result'; requestId: string; result?: unknown; error?: string }
  | { type: 'pty_dead'; agentId: string; dispatchId?: string }
  | { type: 'submit_failed'; agentId: string; reason: 'agent_exited'; queuedCount: number; retryActive: boolean; dispatchIds?: string[] }
  | { type: 'orch_submit_state'; agentId: string; state: 'buffering' | 'pending' | 'forced' | 'submitted'; dispatchId?: string }
  | { type: 'model_switch_confirmed'; agentId: string; model: string }
  | { type: 'model_switch_unconfirmed'; agentId: string; model: string }
  | { type: 'set_model_rejected'; agentId: string; model: string; reason: string }
  | { type: 'agent_models_available'; daemonId: string; agentKey: string; models: string[] }
  | { type: 'daemon_resync'; connectionId: string; panels: import('@jerico/shared').PanelMeta[] }
  | { type: 'codegraph_status'; daemonId: string; health: { status: 'ok' | 'down' | 'error'; error: string | null }; projects: Array<{ cwd: string; indexed: number; total: number; stale: number; lastIndexedAt: number | null; indexing: boolean; coverage: { resolved: number; unresolved: number } }> }
  | { type: 'preview_proxy_ready'; paneId: string; proxyUrl: string }
  | { type: 'preview_proxy_error'; paneId: string; error: string }
  | { type: 'dev_servers'; requestId: string; daemonId: string; servers: import('@jerico/shared').DevServerInfo[]; scannedAt: number; truncated?: boolean; error?: import('@jerico/shared').DevServerDiscoveryError }
  | { type: 'media_preview_result'; requestId: string; daemonId: string; agentId: string; path: string; resolvedPath?: string; kind?: import('@jerico/shared').MediaPreviewKind; mime?: 'image/jpeg' | 'image/png'; data?: string; width?: number; height?: number; mtime?: number; size?: number; playable?: boolean; mediaMime?: 'video/mp4' | 'video/webm'; mediaData?: string; error?: import('@jerico/shared').MediaPreviewError }
