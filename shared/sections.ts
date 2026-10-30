// The section catalogue of the page builder (synthwerk#46, docs/features/page-builder.md).
// A page is a title and a list of typed sections from this fixed catalogue. There is no free
// HTML. Text is plain, or a small Markdown subset (`parseRichText`) that renders as nodes.
// The server checks every save with `checkContent`; the editor and the public site use the same
// types, so both sides agree on what a section is.

export const SECTION_TYPES = ['hero', 'proof', 'benefits', 'pricing', 'faq', 'cta'] as const
export type SectionType = (typeof SECTION_TYPES)[number]

export const SECTION_LABELS: Record<SectionType, string> = {
  hero: 'Hero',
  proof: 'Proof',
  benefits: 'Benefits',
  pricing: 'Pricing',
  faq: 'FAQ',
  cta: 'Call to action'
}

export const LOCALES = ['de', 'en'] as const
export type Locale = (typeof LOCALES)[number]

/** Limits. Text lengths count UTF-16 code units, like `String.length`. */
export const LIMITS = {
  sections: 20,
  /** Titles, labels, names, prices: one line. */
  short: 120,
  /** Markdown bodies and answers. */
  long: 2000,
  /** Button labels. */
  label: 40,
  href: 500,
  proofItems: 6,
  benefitItems: 6,
  plans: 4,
  features: 10,
  faqItems: 12
} as const

export const SECTION_ID_PATTERN = /^[a-z0-9]{1,24}$/
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

export interface Link {
  label: string
  href: string
}

export interface HeroSection {
  id: string
  type: 'hero'
  eyebrow: string
  title: string
  /** Markdown subset. */
  body: string
  primary: Link | null
  secondary: Link | null
}

export interface ProofItem {
  value: string
  label: string
}

export interface ProofSection {
  id: string
  type: 'proof'
  title: string
  items: ProofItem[]
}

export interface BenefitItem {
  title: string
  /** Markdown subset. */
  body: string
}

export interface BenefitsSection {
  id: string
  type: 'benefits'
  title: string
  items: BenefitItem[]
}

export interface Plan {
  name: string
  price: string
  period: string
  features: string[]
  highlighted: boolean
  cta: Link | null
}

export interface PricingSection {
  id: string
  type: 'pricing'
  title: string
  plans: Plan[]
}

export interface FaqItem {
  question: string
  /** Markdown subset. */
  answer: string
}

export interface FaqSection {
  id: string
  type: 'faq'
  title: string
  items: FaqItem[]
}

export interface CtaSection {
  id: string
  type: 'cta'
  title: string
  /** Markdown subset. */
  body: string
  cta: Link
}

export type Section =
  | HeroSection
  | ProofSection
  | BenefitsSection
  | PricingSection
  | FaqSection
  | CtaSection

export interface PageContent {
  title: string
  sections: Section[]
}

/** The input is not a valid page. `path` names the field, for example `sections[2].items[0].title`. */
export class ContentError extends Error {
  constructor(
    readonly path: string,
    message: string
  ) {
    super(`${path}: ${message}`)
    this.name = 'ContentError'
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: the check refuses control characters
const CONTROL_LINE = /[\u0000-\u001f\u007f]/
// biome-ignore lint/suspicious/noControlCharactersInRegex: newline and tab are allowed in long text
const CONTROL_LONG = /[\u0000-\u0008\u000b-\u001f\u007f]/

/**
 * A link target the builder accepts: `https://` or `http://` with a host, `mailto:`, a path on the
 * site (`/…`, not `//`) or a fragment (`#…`). No whitespace or control characters.
 * Returns null when the value is not one of these.
 */
export function safeLinkHref(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const href = value.trim()
  if (href === '' || href.length > LIMITS.href || /[\s\\]/.test(href) || CONTROL_LINE.test(href)) {
    return null
  }
  if (href.startsWith('#')) return href
  if (href.startsWith('/')) return href.startsWith('//') ? null : href
  if (/^mailto:[^/]/i.test(href)) return href
  if (/^https?:\/\//i.test(href)) {
    try {
      const url = new URL(href)
      return url.hostname !== '' && !url.username && !url.password ? href : null
    } catch {
      return null
    }
  }
  return null
}

const asObject = (value: unknown, path: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContentError(path, 'must be an object')
  }
  return value as Record<string, unknown>
}

/** One-line text, trimmed. `min` 1 makes it required. */
function line(value: unknown, path: string, max: number = LIMITS.short, min = 0): string {
  if (value === undefined || value === null) value = ''
  if (typeof value !== 'string') throw new ContentError(path, 'must be a text')
  const text = value.trim()
  if (CONTROL_LINE.test(text)) throw new ContentError(path, 'must be one line of text')
  if (text.length < min) throw new ContentError(path, 'is required')
  if (text.length > max) throw new ContentError(path, `must have ${max} characters or less`)
  return text
}

/** Markdown subset text, trimmed, line ends as `\n`. */
function long(value: unknown, path: string, min = 0): string {
  if (value === undefined || value === null) value = ''
  if (typeof value !== 'string') throw new ContentError(path, 'must be a text')
  const text = value.replace(/\r\n?/g, '\n').trim()
  if (CONTROL_LONG.test(text)) throw new ContentError(path, 'has a control character')
  if (text.length < min) throw new ContentError(path, 'is required')
  if (text.length > LIMITS.long) {
    throw new ContentError(path, `must have ${LIMITS.long} characters or less`)
  }
  return text
}

function list(value: unknown, path: string, max: number, min = 0): unknown[] {
  if (value === undefined || value === null) value = []
  if (!Array.isArray(value)) throw new ContentError(path, 'must be a list')
  if (value.length < min) throw new ContentError(path, `needs at least ${min} item`)
  if (value.length > max) throw new ContentError(path, `can have ${max} items or less`)
  return value
}

function link(value: unknown, path: string): Link {
  const l = asObject(value, path)
  const label = line(l.label, `${path}.label`, LIMITS.label, 1)
  const href = safeLinkHref(l.href)
  if (!href) {
    throw new ContentError(
      `${path}.href`,
      'must be an https, http, mailto, /path or #fragment link'
    )
  }
  return { label, href }
}

const optionalLink = (value: unknown, path: string): Link | null =>
  value === undefined || value === null ? null : link(value, path)

function checkSection(value: unknown, path: string): Section {
  const s = asObject(value, path)
  if (typeof s.id !== 'string' || !SECTION_ID_PATTERN.test(s.id)) {
    throw new ContentError(`${path}.id`, 'must match ^[a-z0-9]{1,24}$')
  }
  const id = s.id
  switch (s.type) {
    case 'hero':
      return {
        id,
        type: 'hero',
        eyebrow: line(s.eyebrow, `${path}.eyebrow`),
        title: line(s.title, `${path}.title`, LIMITS.short, 1),
        body: long(s.body, `${path}.body`),
        primary: optionalLink(s.primary, `${path}.primary`),
        secondary: optionalLink(s.secondary, `${path}.secondary`)
      }
    case 'proof':
      return {
        id,
        type: 'proof',
        title: line(s.title, `${path}.title`),
        items: list(s.items, `${path}.items`, LIMITS.proofItems, 1).map((v, i) => {
          const p = `${path}.items[${i}]`
          const item = asObject(v, p)
          return {
            value: line(item.value, `${p}.value`, 24, 1),
            label: line(item.label, `${p}.label`, LIMITS.short, 1)
          }
        })
      }
    case 'benefits':
      return {
        id,
        type: 'benefits',
        title: line(s.title, `${path}.title`),
        items: list(s.items, `${path}.items`, LIMITS.benefitItems, 1).map((v, i) => {
          const p = `${path}.items[${i}]`
          const item = asObject(v, p)
          return {
            title: line(item.title, `${p}.title`, LIMITS.short, 1),
            body: long(item.body, `${p}.body`)
          }
        })
      }
    case 'pricing':
      return {
        id,
        type: 'pricing',
        title: line(s.title, `${path}.title`),
        plans: list(s.plans, `${path}.plans`, LIMITS.plans, 1).map((v, i) => {
          const p = `${path}.plans[${i}]`
          const plan = asObject(v, p)
          if (plan.highlighted !== undefined && typeof plan.highlighted !== 'boolean') {
            throw new ContentError(`${p}.highlighted`, 'must be true or false')
          }
          return {
            name: line(plan.name, `${p}.name`, LIMITS.short, 1),
            price: line(plan.price, `${p}.price`, 40, 1),
            period: line(plan.period, `${p}.period`, 40),
            features: list(plan.features, `${p}.features`, LIMITS.features).map((f, j) =>
              line(f, `${p}.features[${j}]`, LIMITS.short, 1)
            ),
            highlighted: plan.highlighted === true,
            cta: optionalLink(plan.cta, `${p}.cta`)
          }
        })
      }
    case 'faq':
      return {
        id,
        type: 'faq',
        title: line(s.title, `${path}.title`),
        items: list(s.items, `${path}.items`, LIMITS.faqItems, 1).map((v, i) => {
          const p = `${path}.items[${i}]`
          const item = asObject(v, p)
          return {
            question: line(item.question, `${p}.question`, LIMITS.short * 2, 1),
            answer: long(item.answer, `${p}.answer`, 1)
          }
        })
      }
    case 'cta':
      return {
        id,
        type: 'cta',
        title: line(s.title, `${path}.title`, LIMITS.short, 1),
        body: long(s.body, `${path}.body`),
        cta: link(s.cta, `${path}.cta`)
      }
    default:
      throw new ContentError(`${path}.type`, `must be one of ${SECTION_TYPES.join(', ')}`)
  }
}

/**
 * Checks a page body `{ title, sections }` and returns a clean copy: known fields only, texts
 * trimmed. Throws ContentError at the first bad field.
 */
export function checkContent(value: unknown): PageContent {
  const body = asObject(value, 'content')
  const title = line(body.title, 'title', LIMITS.short, 1)
  const sections = list(body.sections, 'sections', LIMITS.sections).map((s, i) =>
    checkSection(s, `sections[${i}]`)
  )
  const ids = new Set<string>()
  for (const [i, s] of sections.entries()) {
    if (ids.has(s.id)) throw new ContentError(`sections[${i}].id`, 'must be unique on the page')
    ids.add(s.id)
  }
  return { title, sections }
}

/** A new section with example text, so the preview shows something at once. */
export function newSection(type: SectionType, id: string): Section {
  switch (type) {
    case 'hero':
      return {
        id,
        type,
        eyebrow: '',
        title: 'A clear headline',
        body: 'One or two sentences that say **what** it does.',
        primary: { label: 'Get started', href: '#start' },
        secondary: null
      }
    case 'proof':
      return { id, type, title: '', items: [{ value: '99.9 %', label: 'Uptime' }] }
    case 'benefits':
      return {
        id,
        type,
        title: 'Why it helps',
        items: [{ title: 'Benefit', body: 'Why it matters.' }]
      }
    case 'pricing':
      return {
        id,
        type,
        title: 'Pricing',
        plans: [
          {
            name: 'Free',
            price: '0 €',
            period: 'per month',
            features: ['One app'],
            highlighted: false,
            cta: null
          }
        ]
      }
    case 'faq':
      return {
        id,
        type,
        title: 'Questions',
        items: [{ question: 'A question?', answer: 'The answer.' }]
      }
    case 'cta':
      return {
        id,
        type,
        title: 'Ready to start?',
        body: '',
        cta: { label: 'Start now', href: '#start' }
      }
  }
}

/** A short random section id. */
export function newSectionId(): string {
  const bytes = new Uint8Array(8)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 12)
}

// ---- Markdown subset ----------------------------------------------------------------------

export type RichInline =
  | { type: 'text'; text: string }
  | { type: 'strong'; text: string }
  | { type: 'em'; text: string }
  | { type: 'link'; text: string; href: string }
  | { type: 'br' }

export type RichBlock =
  | { type: 'p'; children: RichInline[] }
  | { type: 'ul'; items: RichInline[][] }

const INLINE = /\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|\[([^\]\n]{1,200})\]\(([^)\s]{1,500})\)/g

/** Inline nodes of one line: `**strong**`, `*em*`, `[text](href)`. An unsafe link keeps its text only. */
export function parseInline(text: string): RichInline[] {
  const out: RichInline[] = []
  const push = (node: RichInline) => {
    const last = out[out.length - 1]
    if (node.type === 'text' && last?.type === 'text') last.text += node.text
    else if (node.type !== 'text' || node.text !== '') out.push(node)
  }
  let at = 0
  for (const m of text.matchAll(INLINE)) {
    push({ type: 'text', text: text.slice(at, m.index) })
    if (m[1] !== undefined) push({ type: 'strong', text: m[1] })
    else if (m[2] !== undefined) push({ type: 'em', text: m[2] })
    else {
      const label = m[3] ?? ''
      const href = safeLinkHref(m[4])
      push(href ? { type: 'link', text: label, href } : { type: 'text', text: label })
    }
    at = m.index + m[0].length
  }
  push({ type: 'text', text: text.slice(at) })
  return out
}

/**
 * The Markdown subset: paragraphs (split by a blank line, a line break inside is kept), bullet
 * lists (lines that start with `- `), and the inline marks of `parseInline`. Everything else is
 * text. The result is data: the page renders it as nodes, never as HTML.
 */
export function parseRichText(text: string): RichBlock[] {
  const blocks: RichBlock[] = []
  let para: string[] = []
  let items: string[] = []
  const flushPara = () => {
    if (para.length === 0) return
    const children: RichInline[] = []
    para.forEach((l, i) => {
      if (i > 0) children.push({ type: 'br' })
      children.push(...parseInline(l))
    })
    blocks.push({ type: 'p', children })
    para = []
  }
  const flushList = () => {
    if (items.length === 0) return
    blocks.push({ type: 'ul', items: items.map(parseInline) })
    items = []
  }
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const l = raw.trim()
    if (l === '') {
      flushPara()
      flushList()
    } else if (/^[-*] /.test(l)) {
      flushPara()
      items.push(l.slice(2).trim())
    } else {
      flushList()
      para.push(l)
    }
  }
  flushPara()
  flushList()
  return blocks
}
