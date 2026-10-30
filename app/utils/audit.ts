// Readable lines for the audit list. Known event types get a sentence; any other type gets
// the generic line (type, actor). Plain text only: the page renders it with interpolation.

export interface AuditLine {
  /** The event type without `dev.synthwerk.identity.` and without the version. */
  kind: string
  text: string
}

const PREFIX = 'dev.synthwerk.identity.'

/** `dev.synthwerk.identity.member.invited.v1` -> `member.invited`. Other prefixes stay. */
export function shortType(type: string): string {
  const name = type.startsWith(PREFIX) ? type.slice(PREFIX.length) : type
  return name.replace(/\.v[0-9]+$/, '')
}

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
    default:
      return { kind, text: `${kind} by ${who}` }
  }
}
