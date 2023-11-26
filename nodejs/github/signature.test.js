/* eslint-env jest */
const sig = require('./github-signature')

describe('common/github-signature', () => {
  beforeEach(() => {
    jest.mock('crypto', () => {
      return {
        createHmac: jest.fn().mockReturnThis(),
        update: jest.fn().mockReturnThis(),
        digest: jest.fn(() => 'test-signature')
      }
    })
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('getBodySignature()', () => {
    it('should return body signature', async () => {
      const res = sig.getBodySignature('test-signature', { name: 'test' })
      expect(res).toBe('sha256=97ab4e6242628f32ca2e9ee398c782f6d0e98fcf37918340d8c16b5ac7851822')
    })

    it('should successfully compare signature', async () => {
      const bodySignature = sig.getBodySignature('test-signature', {
        name: 'test'
      })
      const headerSignature = 'sha256=97ab4e6242628f32ca2e9ee398c782f6d0e98fcf37918340d8c16b5ac7851822'
      expect(sig.compareSignatures(bodySignature, headerSignature)).toBe(true)
    })
  })

  describe('getBodySignature()', () => {
    it('should successfully verify GH payload', async () => {
      const verified = sig.verifyGithubPayload({
        key: 'test-signature',
        body: { name: 'test' },
        headers: {
          'x-hub-signature-256': 'sha256=97ab4e6242628f32ca2e9ee398c782f6d0e98fcf37918340d8c16b5ac7851822'
        }
      })
      expect(verified).toBe(true)
    })

    it('should successfully verify invalid GH payload', async () => {
      const verified = sig.verifyGithubPayload({
        key: 'test-signature',
        body: { name: 'test' },
        headers: {
          'x-hub-signature-256': 'sha1=test-signature-invalid'
        }
      })
      expect(verified).toBe(false)
    })
  })
})
