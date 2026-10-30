import { describe, expect, it } from 'vitest'
import { topicOptions, topicPath } from '../../app/utils/labels'

const ids = (topics: { id: string; parent: string | null }[]) =>
  topicOptions(topics).map((o) => `${o.depth}:${o.id}`)

describe('topic options', () => {
  it('parents before children, siblings by id, indented by depth', () => {
    const options = topicOptions([
      { id: 'dog', parent: 'animal' },
      { id: 'place', parent: null },
      { id: 'animal', parent: null },
      { id: 'cat', parent: 'animal' },
      { id: 'barn', parent: 'place' }
    ])
    expect(options.map((o) => `${o.depth}:${o.id}`)).toEqual([
      '0:animal',
      '1:cat',
      '1:dog',
      '0:place',
      '1:barn'
    ])
    expect(options[1]?.text).toBe('   cat')
  })

  it('unknown parent counts as root; a loop shows each topic once', () => {
    expect(ids([{ id: 'a', parent: 'gone' }])).toEqual(['0:a'])
    expect(ids([{ id: 'self', parent: 'self' }])).toEqual(['0:self'])
    expect(
      ids([
        { id: 'x', parent: 'y' },
        { id: 'y', parent: 'x' }
      ])
    ).toEqual(['0:x', '0:y'])
  })

  it('topic path joins with an arrow', () => {
    expect(topicPath(['place', 'building', 'red barn'])).toBe('place → building → red barn')
    expect(topicPath([])).toBe('')
  })
})
