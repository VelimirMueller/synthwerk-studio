import { describe, expect, it } from 'vitest'
import {
  attr,
  buildSnippet,
  defaultSettings,
  readSettings,
  usableIntegrity,
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

  it('versioned URL with SRI - integrity and crossorigin on the script tag', () => {
    const integrity = 'sha384-5pKeePwkGQgg0LEB3qamf7ac3VCWQBfGMfflVp9APDFWh9pU/UXdKk5EqI7Ya8GW'
    const lines = buildSnippet(APP, {
      ...target,
      scriptUrl: 'https://edge.synthwerk.dev/widgets/v0.2.0/synthwerk-chat.js',
      scriptIntegrity: ` ${integrity} `
    }).split('\n')
    expect(lines[0]).toBe(
      `<script type="module" src="https://edge.synthwerk.dev/widgets/v0.2.0/synthwerk-chat.js" integrity="${integrity}" crossorigin="anonymous"></script>`
    )
  })

  it('no or broken integrity - plain script tag, never a broken integrity attribute', () => {
    for (const scriptIntegrity of ['', 'md5-abc', 'sha384-"><img src=x>', 'sha384-short']) {
      const first = buildSnippet(APP, { ...target, scriptIntegrity }).split('\n')[0]
      expect(first).toBe(
        '<script type="module" src="https://cdn.synthwerk.dev/synthwerk-chat.js"></script>'
      )
    }
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

describe('usableIntegrity', () => {
  it.each([
    ['sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=', true],
    ['sha384-OLBgp1GsljhM2TJ+sbHjaiH9txEUvgdDTAzHv2P24donTt6/529l+9Ua0vFImLlb', true],
    [`sha512-${'A'.repeat(86)}==`, true],
    ['sha1-abc', false],
    ['sha384-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=', false],
    ['sha384-', false],
    ['sha384-abc def', false],
    ['', false]
  ])('%s - %s', (value, ok) => {
    expect(usableIntegrity(value)).toBe(ok)
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
