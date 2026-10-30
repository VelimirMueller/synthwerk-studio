import { describe, expect, it } from 'vitest'
import {
  checkLabelId,
  checkLabelInput,
  checkVisionOrg,
  LabelsError,
  VisionLabelsClient
} from '../../server/lib/labels'
import { readVisionConfig, VisionConfigError } from '../../server/lib/vision-config'
import { ADMIN_TOKEN, FakeVision, LABEL, VISION_URL } from '../support/vision'

describe('readVisionConfig', () => {
  const token = { adminToken: ADMIN_TOKEN }

  it('missing or empty URL - throws and names NUXT_VISION_URL', () => {
    for (const raw of [
      {},
      { vision: {} },
      { vision: { url: '  ', ...token } },
      { vision: { url: 5 } }
    ]) {
      expect(() => readVisionConfig(raw)).toThrow(VisionConfigError)
      expect(() => readVisionConfig(raw)).toThrow('NUXT_VISION_URL')
    }
  })

  it('missing token - throws and names NUXT_VISION_ADMIN_TOKEN', () => {
    for (const adminToken of [undefined, '', '   ', 7]) {
      expect(() => readVisionConfig({ vision: { url: VISION_URL, adminToken } })).toThrow(
        'NUXT_VISION_ADMIN_TOKEN'
      )
    }
  })

  it.each([
    'vision.test',
    'ftp://vision.test',
    'http://user:pw@vision.test',
    'http://vision.test/?a=1',
    'http://vision.test/#x'
  ])('bad URL %s - throws, never with the token', (url) => {
    let message = ''
    try {
      readVisionConfig({ vision: { url, ...token } })
    } catch (err) {
      expect(err).toBeInstanceOf(VisionConfigError)
      message = (err as Error).message
    }
    expect(message).toContain('NUXT_VISION_URL')
    expect(message).not.toContain(ADMIN_TOKEN)
  })

  it('good settings - trims the trailing slash and the token', () => {
    expect(
      readVisionConfig({ vision: { url: ' http://vision:8000/ ', adminToken: ` ${ADMIN_TOKEN} ` } })
    ).toEqual({ baseUrl: 'http://vision:8000', adminToken: ADMIN_TOKEN })
  })
})

describe('label input checks', () => {
  it('maps the form body to the vision body', () => {
    expect(
      checkLabelInput({
        name: ' red barn ',
        topic: 'building',
        prompt: '  ',
        newTopic: true,
        topicParent: ''
      })
    ).toEqual({
      name: 'red barn',
      topic: 'building',
      prompt: null,
      new_topic: true,
      topic_parent: null
    })
  })

  it('label id - runtime ids only', () => {
    expect(checkLabelId('runtime:red-barn')).toBe('runtime:red-barn')
    for (const id of [
      'dog',
      'runtime:',
      'runtime:Red',
      'runtime:a/b',
      `runtime:${'a'.repeat(101)}`,
      5
    ]) {
      expect(() => checkLabelId(id)).toThrow(LabelsError)
    }
  })

  it('vision org - Zitadel ids only, else 403', () => {
    expect(checkVisionOrg('3001234567890')).toBe('3001234567890')
    for (const org of ['', 'a/b', 'x'.repeat(65), undefined]) {
      let err: unknown
      try {
        checkVisionOrg(org)
      } catch (e) {
        err = e
      }
      expect(err).toMatchObject({ status: 403, code: 'forbidden' })
    }
  })
})

describe('VisionLabelsClient', () => {
  it('keeps the contract fields of a label and a null prompt', async () => {
    const vision = new FakeVision()
    vision.answers.set('POST /v1/orgs/o1/labels', {
      status: 201,
      body: { ...LABEL, prompt: undefined, extra: 1 }
    })
    const client = new VisionLabelsClient({
      baseUrl: VISION_URL,
      adminToken: ADMIN_TOKEN,
      fetch: vision.fetch
    })
    const label = await client.addLabel('o1', {
      name: 'red barn',
      topic: 'building',
      prompt: null,
      new_topic: false,
      topic_parent: null
    })
    expect(label).toEqual({ ...LABEL, prompt: null })
  })
})
