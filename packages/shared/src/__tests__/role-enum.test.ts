import { describe, it, expect } from 'vitest'
import { AGENT_ROLES, USER_ASSIGNABLE_ROLES, EVENT_ROLES } from '../types.js'

describe('AGENT_ROLES', () => {
  it('contains all 7 agent roles in canonical order', () => {
    expect(AGENT_ROLES).toEqual([
      'developer',
      'reviewer',
      'planner',
      'executor',
      'shell',
      'runner',
      'orchestrator',
    ])
  })
})

describe('USER_ASSIGNABLE_ROLES', () => {
  it('excludes orchestrator', () => {
    expect(USER_ASSIGNABLE_ROLES.includes('orchestrator' as never)).toBe(false)
  })

  it('contains all other 6 roles', () => {
    expect(USER_ASSIGNABLE_ROLES).toEqual([
      'developer',
      'reviewer',
      'planner',
      'executor',
      'shell',
      'runner',
    ])
  })
})

describe('EVENT_ROLES', () => {
  it('includes all agent roles plus system', () => {
    expect(EVENT_ROLES).toContain('system')
    for (const role of AGENT_ROLES) {
      expect(EVENT_ROLES).toContain(role)
    }
    expect(EVENT_ROLES.length).toBe(AGENT_ROLES.length + 1)
  })
})
