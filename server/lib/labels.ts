// Client for the label-set admin routes of synthwerk-vision (synthwerk#44). It calls vision with
// the service token of the studio server. Vision trusts the org id in the path, so the caller
// (LabelsApi) authorizes the user first. It never logs the token or vision's `detail`.

export interface Topic {
  id: string
  parent: string | null
  depth: number
}

export interface RuntimeLabel {
  id: string
  name: string
  topic: string
  prompt: string | null
  path: string[]
}

export interface LabelSet {
  org_id: string
  /** false = the org uses the default set (no own set yet). */
  custom: boolean
  /** The labels added on top of the packaged taxonomy. Only these can be deleted. */
  labels: RuntimeLabel[]
  /** Every topic of the org's taxonomy, for the add form. */
  topics: Topic[]
  /** All labels the model scores for this org (packaged and added). */
  total_labels: number
}

/** The body vision takes on POST /v1/orgs/{org_id}/labels. */
export interface LabelInput {
  name: string
  topic: string
  prompt: string | null
  new_topic: boolean
  topic_parent: string | null
}

/** A vision call failed, or the input was refused before the call. */
export class LabelsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'LabelsError'
  }
}

/** The vision org key: the Zitadel org id. */
export const VISION_ORG_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
export const LABEL_ID_PATTERN = /^runtime:[a-z0-9-]{1,100}$/
export const MAX_NAME_LENGTH = 80
export const MAX_PROMPT_LENGTH = 200
/** Adding a label can take about 30 s when vision embeds a new text. */
const WRITE_TIMEOUT_MS = 60_000
const READ_TIMEOUT_MS = 10_000

const invalid = (message: string) => new LabelsError(400, 'invalid_request', message)
const unavailable = (message: string) => new LabelsError(502, 'vision_unavailable', message)

/** A required text: trimmed, 1 to max characters. */
function checkText(value: unknown, field: string, max: number): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length < 1 || text.length > max) {
    throw invalid(`${field} must have 1 to ${max} characters`)
  }
  return text
}

/** An optional text: trimmed, at most max characters. Absent, null or empty gives null. */
function checkOptionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw invalid(`${field} must be a text`)
  const text = value.trim()
  if (text.length > max) throw invalid(`${field} must have ${max} characters or less`)
  return text === '' ? null : text
}

/** Checks the add form body ({ name, topic, prompt?, newTopic?, topicParent? }). */
export function checkLabelInput(body: Record<string, unknown>): LabelInput {
  const newTopic = body.newTopic ?? false
  if (typeof newTopic !== 'boolean') throw invalid('newTopic must be true or false')
  return {
    name: checkText(body.name, 'name', MAX_NAME_LENGTH),
    topic: checkText(body.topic, 'topic', MAX_NAME_LENGTH),
    prompt: checkOptionalText(body.prompt, 'prompt', MAX_PROMPT_LENGTH),
    new_topic: newTopic,
    topic_parent: checkOptionalText(body.topicParent, 'topicParent', MAX_NAME_LENGTH)
  }
}

export function checkLabelId(value: unknown): string {
  if (typeof value !== 'string' || !LABEL_ID_PATTERN.test(value)) {
    throw invalid('label id is not valid')
  }
  return value
}

/** The vision org key of the session. A bad value is refused as forbidden. */
export function checkVisionOrg(value: unknown): string {
  if (typeof value !== 'string' || !VISION_ORG_PATTERN.test(value)) {
    throw new LabelsError(403, 'forbidden', 'the session has no usable org id')
  }
  return value
}

export interface VisionLabelsClientOptions {
  baseUrl: string
  adminToken: string
  fetch?: typeof fetch
}

export class VisionLabelsClient {
  private readonly fetch: typeof fetch

  constructor(private readonly options: VisionLabelsClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch
  }

  async getLabelSet(orgId: string): Promise<LabelSet> {
    return readLabelSet(await this.call('GET', `${orgPath(orgId)}/labels`))
  }

  /** 201 with the new label. The first change copies the default set into an own set. */
  async addLabel(orgId: string, input: LabelInput): Promise<RuntimeLabel> {
    return readLabel(await this.call('POST', `${orgPath(orgId)}/labels`, input))
  }

  /** 204: the label is gone from the org's set. */
  async deleteLabel(orgId: string, labelId: string): Promise<void> {
    await this.call('DELETE', `${orgPath(orgId)}/labels/${encodeURIComponent(labelId)}`)
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${this.options.adminToken}`
    }
    if (body !== undefined) headers['content-type'] = 'application/json'
    let res: Response
    try {
      res = await this.fetch(`${this.options.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(method === 'POST' ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS)
      })
    } catch {
      throw unavailable('vision is not reachable')
    }
    if (res.status === 204) return null
    if (res.ok) {
      try {
        return await res.json()
      } catch {
        throw unavailable('vision gave a bad answer')
      }
    }
    // The body can hold vision's `detail`: it never leaves the BFF.
    void res.body?.cancel()
    throw toError(method, res.status)
  }
}

const orgPath = (orgId: string) => `/v1/orgs/${encodeURIComponent(orgId)}`

/**
 * Maps a vision error status. 401 and 404 outside DELETE mean a wrong token or admin routes
 * that are off: an operator problem, so 502 for the browser.
 */
function toError(method: string, status: number): LabelsError {
  if (status === 404 && method === 'DELETE') {
    return new LabelsError(404, 'not_found', 'vision has no such label')
  }
  if (status === 409) return new LabelsError(409, 'label_conflict', 'vision refused the change')
  if (status === 422) return invalid('vision refused the input')
  if (status === 503) return new LabelsError(503, 'vision_unavailable', 'vision answered 503')
  if (status === 401) return unavailable('vision refused the admin token (401)')
  if (status === 404) return unavailable('vision admin routes are off (404)')
  return unavailable(`vision answered ${status}`)
}

const bad = () => unavailable('vision gave a bad label set')

const isText = (v: unknown): v is string => typeof v === 'string'

/** Keeps only the contract fields of a runtime label. */
function readLabel(value: unknown): RuntimeLabel {
  const l = value as Record<string, unknown> | null
  if (
    !l ||
    !isText(l.id) ||
    !isText(l.name) ||
    !isText(l.topic) ||
    !(l.prompt === null || l.prompt === undefined || isText(l.prompt)) ||
    !Array.isArray(l.path) ||
    !l.path.every(isText)
  ) {
    throw bad()
  }
  return {
    id: l.id,
    name: l.name,
    topic: l.topic,
    prompt: isText(l.prompt) ? l.prompt : null,
    path: [...l.path]
  }
}

/** Keeps only the contract fields of a topic. */
function readTopic(value: unknown): Topic {
  const t = value as Record<string, unknown> | null
  if (
    !t ||
    !isText(t.id) ||
    !(t.parent === null || t.parent === undefined || isText(t.parent)) ||
    typeof t.depth !== 'number' ||
    !Number.isInteger(t.depth) ||
    t.depth < 0
  ) {
    throw bad()
  }
  return { id: t.id, parent: isText(t.parent) ? t.parent : null, depth: t.depth }
}

/** Keeps only the contract fields of a label set. */
function readLabelSet(value: unknown): LabelSet {
  const s = value as Record<string, unknown> | null
  if (
    !s ||
    !isText(s.org_id) ||
    typeof s.custom !== 'boolean' ||
    !Array.isArray(s.labels) ||
    !Array.isArray(s.topics) ||
    typeof s.total_labels !== 'number' ||
    !Number.isInteger(s.total_labels) ||
    s.total_labels < 0
  ) {
    throw bad()
  }
  return {
    org_id: s.org_id,
    custom: s.custom,
    labels: s.labels.map(readLabel),
    topics: s.topics.map(readTopic),
    total_labels: s.total_labels
  }
}
