export type BridgeToolCapability =
  | 'workspace.read'
  | 'project.read'
  | 'project.write'
  | 'orchestration.observe'
  | 'orchestration.execute'
  | 'orchestration.interactive_control'
  | 'shared_assets.read'
  | 'shared_assets.write_own'
  | 'prompts.read'
  | 'prompts.write'
  | 'events.read'
  | 'events.write'

/**
 * Closed documentation/audit map. Enforcement remains exclusively in the
 * Bridge HTTP API; MCP handlers never consult this map to authorize a call.
 */
export const BRIDGE_TOOL_CAPABILITIES = {
  bridge_codegraph_status: 'project.read',
  bridge_codegraph_index: 'project.read',
  bridge_codegraph_find_symbol: 'project.read',
  bridge_codegraph_file_outline: 'project.read',
  bridge_codegraph_find_references: 'project.read',
  bridge_codegraph_call_graph: 'project.read',
  bridge_codegraph_get_symbol_source: 'project.read',
  bridge_codegraph_diff_impact: 'project.read',

  bridge_list_group_schemas: 'shared_assets.read',
  bridge_apply_group_schema: 'orchestration.execute',
  bridge_create_group_schema: 'shared_assets.write_own',
  bridge_update_group_schema: 'shared_assets.write_own',
  bridge_list_agent_models: 'orchestration.observe',

  bridge_send_message: 'orchestration.execute',
  bridge_poll_messages: 'orchestration.observe',

  bridge_get_session_context: 'workspace.read',
  bridge_get_my_task: 'orchestration.observe',
  bridge_complete_task: 'orchestration.execute',
  bridge_fail_task: 'orchestration.execute',
  bridge_get_free_task_outcome: 'orchestration.observe',
  bridge_complete_free_task: 'orchestration.execute',
  bridge_ack_scheduled_duty: 'orchestration.execute',
  bridge_get_todo_context: 'orchestration.observe',
  bridge_list_agents: 'orchestration.observe',
  bridge_get_agent_status: 'orchestration.observe',
  bridge_spawn_worker: 'orchestration.execute',
  bridge_kill_agent: 'orchestration.execute',
  bridge_set_model: 'orchestration.execute',
  bridge_get_agent_output: 'orchestration.observe',
  bridge_send_input: 'orchestration.execute',
  bridge_send_keys: 'orchestration.interactive_control',
  bridge_dispatch_brief: 'orchestration.execute',
  bridge_watch_panel: 'orchestration.execute',
  bridge_dispatch_free_task: 'orchestration.execute',
  bridge_unwatch_panel: 'orchestration.execute',
  bridge_get_project_history: 'orchestration.observe',
  bridge_assign_task: 'orchestration.execute',
  bridge_agent_is_idle: 'orchestration.observe',
  bridge_record_event: 'events.write',
  bridge_get_project_events: 'events.read',
  bridge_get_project_memory: 'events.read',

  bridge_list_personas: 'shared_assets.read',
  bridge_get_persona: 'shared_assets.read',
  bridge_create_persona: 'shared_assets.write_own',
  bridge_update_persona: 'shared_assets.write_own',
  bridge_archive_persona: 'shared_assets.write_own',
  bridge_launch_persona: 'orchestration.execute',
  bridge_apply_persona: 'orchestration.execute',
  bridge_persona_schedule: 'orchestration.execute',

  bridge_get_execution_status: 'orchestration.observe',
  bridge_get_todo_run_instructions: 'prompts.read',
  bridge_get_blueprint: 'project.read',
  bridge_update_blueprint: 'project.write',
  bridge_get_plan: 'project.read',
  bridge_update_plan: 'project.write',

  bridge_list_role_prompts: 'prompts.read',
  bridge_get_role_prompt: 'prompts.read',
  bridge_update_role_prompt: 'prompts.write',
  bridge_delete_role_prompt: 'prompts.write',

  bridge_get_todos: 'orchestration.observe',
  bridge_cancel_run: 'orchestration.execute',
  bridge_add_todo: 'orchestration.execute',
  bridge_update_todo: 'orchestration.execute',
  bridge_update_todo_status: 'orchestration.execute',

  bridge_list_groups: 'shared_assets.read',
  bridge_get_group_status: 'shared_assets.read',
  bridge_dispatch_to_group: 'orchestration.execute',
  bridge_list_workspace_projects: 'project.read',
  bridge_get_project: 'project.read',
  bridge_get_project_digest: 'project.read',
  bridge_query_workspace: 'orchestration.observe',
  bridge_list_active_runs: 'orchestration.observe',
  bridge_peek_panel: 'orchestration.observe',
  bridge_status_panel: 'orchestration.observe',
  bridge_create_group: 'shared_assets.write_own',
  bridge_update_group: 'shared_assets.write_own',
  bridge_assign_agent_to_group: 'orchestration.execute',
  bridge_delete_group: 'shared_assets.write_own',
} as const satisfies Record<string, BridgeToolCapability>

export type BridgeToolName = keyof typeof BRIDGE_TOOL_CAPABILITIES
