import { describe, expect, it } from 'vitest'
import {
  attr,
  buildSnippet,
  defaultSettings,
  readSettings,
  usableUrl,
  validGreeting
} from '../../shared/widget'

const APP = '019a3b10-7c2d-7e4f-8a5b-6c7d8e9f0a1b'
const target = {
  scriptUrl: 'https://cdn.synthwerk.dev/synthwerk-chat.js',
  apiUrl: 'https://api.synthwerk.dev'
}

describe('buildSnippet', () => {
  it('app and config - one module script, one <synthwerk-chat> with app-id and api-url, the token hook', () => {
    const lines = buildSnippet(APP, target).split('\n')
    expect(lines[0]).toBe(
      '<script type="module" src="https://cdn.synthwerk.dev/synthwerk-chat.js"></script>'
    )
    expect(lines[1]).toBe(
      `<synthwerk-chat app-id="${APP}" api-url="https://api.synthwerk.dev"></synthwerk-chat>`
    )
    expect(lines.join('\n')).toContain('.getUserToken = () =>')
  })

  it('settings - never in the snippet - the widget loads them, an attribute would win', () => {
    const snippet = buildSnippet(APP, target)
    for (const name of ['position=', 'mode=', 'lang=', 'theme=', 'greeting']) {
      expect(snippet).not.toContain(name)
    }
  })

  it('config with quotes and angle brackets - escaped, no attribute break-out', () => {
    const snippet = buildSnippet(APP, {
      scriptUrl: 'https://x.example/a"><img src=x onerror=alert(1)>',
      apiUrl: 'https://x.example/&'
    })
    expect(snippet).not.toContain('"><img')
    expect(snippet).toContain('&quot;&gt;&lt;img')
    expect(snippet).toContain('api-url="https://x.example/&amp;"')
    expect(attr('<a "b" & c>')).toBe('&lt;a &quot;b&quot; &amp; c&gt;')
  })
})

describe('usableUrl', () => {
  it.each([
    ['https://cdn.example/x.js', true],
    ['http://localhost:4174/dist/synthwerk-chat.js', true],
    ['http://127.0.0.1:8080', true],
    ['http://cdn.example/x.js', false],
    ['javascript:alert(1)', false],
    ['/relative.js', false],
    ['https://user:pw@cdn.example/x.js', false],
    ['', false]
  ])('%s - %s', (value, ok) => {
    expect(usableUrl(value)).toBe(ok)
  })
})

describe('readSettings', () => {
  it('defaults - accepted as they are', () => {
    expect(readSettings(defaultSettings())).toEqual(defaultSettings())
  })

  it('greeting with spaces and a line break - trimmed, line break kept', () => {
    const s = readSettings({ ...defaultSettings(), greeting: '  Hallo!\nWie geht es?  ' })
    expect(s?.greeting).toBe('Hallo!\nWie geht es?')
  })

  it.each([
    ['free colour', { accent: '#ff00ff' }],
    ['unknown theme', { theme: 'neon' }],
    ['unknown position', { position: 'top-left' }],
    ['greeting too long', { greeting: 'a'.repeat(281) }],
    ['control character', { greeting: 'a\u0007b' }],
    ['greeting not a string', { greeting: 3 }],
    ['extra field', { css: 'body{}' }]
  ])('%s - refused', (_name, change) => {
    expect(readSettings({ ...defaultSettings(), ...change })).toBeNull()
  })

  it('missing field, array, null - refused', () => {
    const { lang: _lang, ...partial } = defaultSettings()
    expect(readSettings(partial)).toBeNull()
    expect(readSettings([])).toBeNull()
    expect(readSettings(null)).toBeNull()
  })

  it('greeting of 280 characters outside the BMP - accepted (counts characters, not code units)', () => {
    expect(validGreeting('😀'.repeat(280))).toBe(true)
    expect(validGreeting('😀'.repeat(281))).toBe(false)
  })
})
