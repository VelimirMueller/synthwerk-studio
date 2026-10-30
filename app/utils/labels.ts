// Pure helpers for the labels page. Text only: the page never renders HTML from vision.

export interface TopicLike {
  id: string
  parent: string | null
}

export interface TopicOption {
  id: string
  /** The topic id, indented by its depth in the tree. */
  text: string
  depth: number
}

/** Indent per level. Non-breaking spaces, because a select collapses normal spaces. */
const INDENT = '   '

/**
 * The topics as a tree for a select: every parent before its children, siblings by id.
 * A topic whose parent is unknown counts as a root. A loop never repeats a topic.
 */
export function topicOptions(topics: readonly TopicLike[]): TopicOption[] {
  const ids = new Set(topics.map((t) => t.id))
  const children = new Map<string | null, string[]>()
  for (const t of topics) {
    const parent = t.parent !== null && ids.has(t.parent) && t.parent !== t.id ? t.parent : null
    children.set(parent, [...(children.get(parent) ?? []), t.id])
  }
  const out: TopicOption[] = []
  const seen = new Set<string>()
  const walk = (parent: string | null, depth: number) => {
    for (const id of [...(children.get(parent) ?? [])].sort()) {
      if (seen.has(id)) continue
      seen.add(id)
      out.push({ id, text: `${INDENT.repeat(depth)}${id}`, depth })
      walk(id, depth + 1)
    }
  }
  walk(null, 0)
  // Topics in a loop without a root still show, flat, after the tree.
  for (const t of [...topics].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!seen.has(t.id)) {
      seen.add(t.id)
      out.push({ id: t.id, text: t.id, depth: 0 })
    }
  }
  return out
}

/** The topic path of a label for the table, for example "animal → dog". */
export const topicPath = (path: readonly string[]): string => path.join(' → ')
