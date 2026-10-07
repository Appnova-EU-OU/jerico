// ============================================================================
// Blueprint doc format (issue #512 D4) — the project blueprint is ONE markdown
// document stored in projects.description. Canonical structure: three H1 areas
// (# Frontend / # Backend / # Other), each with the same four H2 aspects
// (## Architecture / ## Conventions / ## Features / ## Decisions). Mermaid
// fences stay as plain source blocks in v1 (no mermaid renderer).
//
// The template below is the empty scaffold the UI offers when a project has
// no blueprint yet, and the shape the orchestrator is asked to maintain via
// bridge_update_blueprint.
// ============================================================================

export const BLUEPRINT_H1_AREAS = ['Frontend', 'Backend', 'Other'] as const
export const BLUEPRINT_H2_ASPECTS = ['Architecture', 'Conventions', 'Features', 'Decisions'] as const

export const BLUEPRINT_DOC_TEMPLATE: string = BLUEPRINT_H1_AREAS
  .map(area => `# ${area}\n\n` + BLUEPRINT_H2_ASPECTS.map(aspect => `## ${aspect}\n`).join('\n'))
  .join('\n')
