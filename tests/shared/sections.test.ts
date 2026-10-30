import { describe, expect, it } from 'vitest'
import {
  ContentError,
  checkContent,
  LIMITS,
  newSection,
  newSectionId,
  parseInline,
  parseRichText,
  SECTION_TYPES,
  safeLinkHref
} from '../../shared/sections'

const hero = {
  id: 'a1',
  type: 'hero',
  eyebrow: ' New ',
  title: ' Synthwerk ',
  body: 'Line one\r\nline two',
  primary: { label: 'Start', href: 'https://example.com/start' },
  secondary: null
}

const errorPath = (fn: () => unknown) => {
  try {
    fn()
  } catch (err) {
    if (err instanceof ContentError) return err.path
    throw err
  }
  return 'no error'
}

describe('checkContent', () => {
  it('keeps known fields only, trims texts, normalizes line ends', () => {
    const content = checkContent({
      title: ' Home ',
      extra: 'x',
      sections: [{ ...hero, html: '<script>x</script>' }]
    })
    expect(content).toEqual({
      title: 'Home',
      sections: [
        {
          id: 'a1',
          type: 'hero',
          eyebrow: 'New',
          title: 'Synthwerk',
          body: 'Line one\nline two',
          primary: { label: 'Start', href: 'https://example.com/start' },
          secondary: null
        }
      ]
    })
  })

  it('accepts every new section of the catalogue', () => {
    const sections = SECTION_TYPES.map((t, i) => newSection(t, `s${i}`))
    expect(checkContent({ title: 'All', sections }).sections).toEqual(sections)
  })

  it('accepts an empty page and missing optional fields', () => {
    expect(checkContent({ title: 'Empty' })).toEqual({ title: 'Empty', sections: [] })
    const s = checkContent({
      title: 't',
      sections: [{ id: 'x', type: 'cta', title: 'Go', cta: { label: 'Go', href: '/go' } }]
    })
    expect(s.sections[0]).toEqual({
      id: 'x',
      type: 'cta',
      title: 'Go',
      body: '',
      cta: { label: 'Go', href: '/go' }
    })
  })

  it.each([
    [{ title: '' }, 'title'],
    [{ title: 'a\nb' }, 'title'],
    [[], 'content'],
    [{ title: 't', sections: 'x' }, 'sections'],
    [{ title: 't', sections: [{ ...hero, type: 'html' }] }, 'sections[0].type'],
    [{ title: 't', sections: [{ ...hero, id: 'A B' }] }, 'sections[0].id'],
    [{ title: 't', sections: [hero, hero] }, 'sections[1].id'],
    [
      { title: 't', sections: [{ ...hero, title: 'x'.repeat(LIMITS.short + 1) }] },
      'sections[0].title'
    ],
    [
      { title: 't', sections: [{ ...hero, body: 'x'.repeat(LIMITS.long + 1) }] },
      'sections[0].body'
    ],
    [{ title: 't', sections: [{ ...hero, body: 'a\u0000b' }] }, 'sections[0].body'],
    [{ title: 't', sections: [{ ...hero, title: 7 }] }, 'sections[0].title'],
    [
      { title: 't', sections: [{ ...hero, primary: { label: 'x', href: 'javascript:alert(1)' } }] },
      'sections[0].primary.href'
    ],
    [
      { title: 't', sections: [{ ...hero, primary: { label: '', href: '/' } }] },
      'sections[0].primary.label'
    ],
    [{ title: 't', sections: [{ id: 'p', type: 'proof', items: [] }] }, 'sections[0].items'],
    [
      { title: 't', sections: [{ id: 'p', type: 'proof', items: [{ value: '1' }] }] },
      'sections[0].items[0].label'
    ],
    [{ title: 't', sections: [{ id: 'b', type: 'benefits', items: [3] }] }, 'sections[0].items[0]'],
    [
      {
        title: 't',
        sections: [
          { id: 'p', type: 'pricing', plans: [{ name: 'a', price: '1', highlighted: 'yes' }] }
        ]
      },
      'sections[0].plans[0].highlighted'
    ],
    [
      {
        title: 't',
        sections: [{ id: 'p', type: 'pricing', plans: [{ name: 'a', price: '1', features: [''] }] }]
      },
      'sections[0].plans[0].features[0]'
    ],
    [
      { title: 't', sections: [{ id: 'f', type: 'faq', items: [{ question: 'q', answer: '' }] }] },
      'sections[0].items[0].answer'
    ],
    [{ title: 't', sections: [{ id: 'c', type: 'cta', title: 'x' }] }, 'sections[0].cta'],
    [
      {
        title: 't',
        sections: Array.from({ length: LIMITS.sections + 1 }, (_, i) => newSection('cta', `c${i}`))
      },
      'sections'
    ]
  ])('refuses %j at %s', (input, path) => {
    expect(errorPath(() => checkContent(input))).toBe(path)
  })
})

describe('safeLinkHref', () => {
  it.each([
    'https://example.com',
    'http://example.com/a?b=c#d',
    'mailto:hi@example.com',
    '/pricing',
    '#faq'
  ])('accepts %s', (href) => {
    expect(safeLinkHref(href)).toBe(href)
  })

  it.each([
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'data:text/html,x',
    '//evil.example',
    'https://user:pw@example.com',
    'https://',
    'java\tscript:x',
    '/a b',
    '/a\\b',
    'ftp://example.com',
    'relative/path',
    '',
    `https://example.com/${'a'.repeat(LIMITS.href)}`,
    42
  ])('refuses %j', (href) => {
    expect(safeLinkHref(href)).toBeNull()
  })
})

describe('parseRichText', () => {
  it('makes paragraphs, line breaks, lists and inline marks', () => {
    expect(
      parseRichText('Hello **bold** and *em*\nnext [docs](/docs)\n\n- one\n* two **x**')
    ).toEqual([
      {
        type: 'p',
        children: [
          { type: 'text', text: 'Hello ' },
          { type: 'strong', text: 'bold' },
          { type: 'text', text: ' and ' },
          { type: 'em', text: 'em' },
          { type: 'br' },
          { type: 'text', text: 'next ' },
          { type: 'link', text: 'docs', href: '/docs' }
        ]
      },
      {
        type: 'ul',
        items: [
          [{ type: 'text', text: 'one' }],
          [
            { type: 'text', text: 'two ' },
            { type: 'strong', text: 'x' }
          ]
        ]
      }
    ])
  })

  it('keeps HTML as text and drops an unsafe link target', () => {
    expect(parseInline('<img src=x onerror=alert(1)> [click](javascript:void)')).toEqual([
      { type: 'text', text: '<img src=x onerror=alert(1)> click' }
    ])
  })

  it('a list item ends a paragraph and a paragraph line ends a list', () => {
    expect(parseRichText('a\n- b\nc').map((b) => b.type)).toEqual(['p', 'ul', 'p'])
    expect(parseRichText('')).toEqual([])
  })
})

it('newSectionId gives ids the checker accepts', () => {
  const ids = new Set(Array.from({ length: 50 }, () => newSectionId()))
  expect(ids.size).toBe(50)
  for (const id of ids) expect(id).toMatch(/^[a-z0-9]{1,24}$/)
})
