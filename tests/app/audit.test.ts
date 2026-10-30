import { describe, expect, it } from 'vitest'
import { actorLabel, describeAuditEvent, shortType } from '../../app/utils/audit'

const ev = (type: string, data: Record<string, unknown>, actor = 'user:u1', subject?: string) => ({
  type: `dev.synthwerk.identity.${type}.v1`,
  actor,
  data,
  ...(subject ? { subject } : {})
})

describe('audit lines', () => {
  it('shortType - strips the identity prefix and the version only', () => {
    expect(shortType('dev.synthwerk.identity.member.invited.v1')).toBe('member.invited')
    expect(shortType('dev.synthwerk.llm.usage.recorded.v2')).toBe('llm.usage.recorded')
    expect(shortType('dev.synthwerk.pulse.check.failed.v1')).toBe(
      'dev.synthwerk.pulse.check.failed'
    )
  })

  it.each([
    [
      { version: 3, changed: ['max_input_chars', 'system_prompt'] },
      'user u1 changed the AI settings: max_input_chars, system_prompt (version 3)'
    ],
    [
      { version: 4, changed: ['temperature', '<b>x</b>', 7, 'temperature'] },
      'user u1 changed the AI settings: temperature (version 4)'
    ],
    [{ changed: 'model' }, 'user u1 changed the AI settings (version ?)']
  ])(
    'llm.ai_settings.changed %# - known setting names and the version, plain text',
    (data, text) => {
      const line = describeAuditEvent({
        type: 'dev.synthwerk.llm.ai_settings.changed.v1',
        actor: 'user:u1',
        data
      })
      expect(line).toEqual({ kind: 'llm.ai_settings.changed', text })
    }
  )

  it('actorLabel - user, service and system', () => {
    expect(actorLabel('user:123')).toBe('user 123')
    expect(actorLabel('service:llm')).toBe('service llm')
    expect(actorLabel('system')).toBe('system')
  })

  it.each([
    [
      ev('member.role_changed', { user_sub: 'u2', old_role: 'member', new_role: 'admin' }),
      'user u1 changed user u2 from member to admin'
    ],
    [
      ev('member.invited', {
        invitation_id: '019a3c1e-7a1b-7c2d-8e3f-4a5b6c7d8e9f',
        role: 'member'
      }),
      'user u1 invited an email as member (invitation …4a5b6c7d8e9f)'
    ],
    [
      ev('member.invite_revoked', {
        invitation_id: '019a3c1e-7a1b-7c2d-8e3f-4a5b6c7d8e9f',
        role: 'admin'
      }),
      'user u1 revoked the admin invitation (invitation …4a5b6c7d8e9f)'
    ],
    [
      ev('member.deactivated', { user_sub: 'u2', role: 'admin' }),
      'user u1 deactivated user u2 (admin)'
    ],
    [
      ev('member.reactivated', { role: 'admin' }, 'user:u1', 's9'),
      'user u1 reactivated user s9 (admin)'
    ],
    [
      ev('org.created', { name: 'demo', slug: 'demo' }, 'system'),
      'system created the org demo (demo)'
    ],
    [ev('app.created', { name: 'Shop' }), 'user u1 created the app Shop'],
    [
      ev('org.entitlements_changed', { plan: 'free', reason: 'plan_assigned' }, 'system'),
      'system changed the plan to free (plan_assigned)'
    ],
    [ev('member.invited', {}), 'user u1 invited an email as ? (invitation …?)'],
    [ev('org.renamed', { name: 'x' }, 'service:identity'), 'org.renamed by service identity']
  ])('describeAuditEvent %#', (event, text) => {
    expect(describeAuditEvent(event).text).toBe(text)
  })
})
