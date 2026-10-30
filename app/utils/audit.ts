// Readable lines for the audit list. Known event types get a sentence; any other type gets
// the generic line (type, actor). Plain text only: the page renders it with interpolation.

export interface AuditLine {
  /** The event type without `dev.synthwerk.identity.` (llm: `llm.`) and without the version. */
  kind: string
  text: string
}

const PREFIX = 'dev.synthwerk.identity.'
const LLM_PREFIX = 'dev.synthwerk.'

/**
 * `dev.synthwerk.identity.member.invited.v1` -> `member.invited`,
 * `dev.synthwerk.llm.ai_settings.changed.v1` -> `llm.ai_settings.changed`. Other prefixes stay.
 */
export function shortType(type: string): string {
  let name = type
  if (type.startsWith(PREFIX)) name = type.slice(PREFIX.length)
  else if (type.startsWith(`${LLM_PREFIX}llm.`)) name = type.slice(LLM_PREFIX.length)
  return name.replace(/\.v[0-9]+$/, '')
}

/** The setting names of `llm.ai_settings.changed` the line shows. Other names are dropped. */
const AI_SETTINGS = [
  'model',
  'allowed_models',
  'system_prompt',
  'max_input_chars',
  'user_tokens_per_day',
  'temperature'
]

/** "max_input_chars, system_prompt": the known names of `data.changed`, each once. */
const changedSettings = (value: unknown): string =>
  Array.isArray(value)
    ? [...new Set(value.filter((n): n is string => AI_SETTINGS.includes(n)))].join(', ')
    : ''

const versionText = (value: unknown): string =>
  typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '?'

/** `user:123` -> `user 123`, `service:llm` -> `service llm`, `system` -> `system`. */
export function actorLabel(actor: string): string {
  const [kind, ...rest] = actor.split(':')
  const id = rest.join(':')
  return id ? `${kind} ${id}` : actor
}

const text = (value: unknown, fallback = '?'): string =>
  typeof value === 'string' && value !== '' ? value : fallback

/** Short form of the invitation id: its last 12 characters. */
const invitation = (d: Record<string, unknown>, event: { subject?: string }): string =>
  `invitation …${text(d.invitation_id, event.subject ?? '?').slice(-12)}`

/** One readable line per event. Unknown types: "<type> by <actor>". */
export function describeAuditEvent(event: {
  type: string
  actor: string
  subject?: string
  data: Record<string, unknown>
}): AuditLine {
  const kind = shortType(event.type)
  const who = actorLabel(event.actor)
  const d = event.data ?? {}
  const user = `user ${text(d.user_sub, event.subject ?? '?')}`
  switch (kind) {
    case 'member.role_changed':
      return {
        kind,
        text: `${who} changed ${user} from ${text(d.old_role)} to ${text(d.new_role)}`
      }
    case 'member.invited':
      return { kind, text: `${who} invited an email as ${text(d.role)} (${invitation(d, event)})` }
    case 'member.invite_revoked':
      return {
        kind,
        text: `${who} revoked the ${text(d.role)} invitation (${invitation(d, event)})`
      }
    case 'member.deactivated':
      return { kind, text: `${who} deactivated ${user} (${text(d.role)})` }
    case 'member.reactivated':
      return { kind, text: `${who} reactivated ${user} (${text(d.role)})` }
    case 'org.created':
      return { kind, text: `${who} created the org ${text(d.name)} (${text(d.slug)})` }
    case 'app.created':
      return { kind, text: `${who} created the app ${text(d.name)}` }
    case 'org.entitlements_changed':
      return {
        kind,
        text: `${who} changed the plan to ${text(d.plan)} (${text(d.reason, 'no reason')})`
      }
    case 'llm.ai_settings.changed': {
      const names = changedSettings(d.changed)
      return {
        kind,
        text: `${who} changed the AI settings${names ? `: ${names}` : ''} (version ${versionText(d.version)})`
      }
    }
    default:
      return { kind, text: `${kind} by ${who}` }
  }
}
