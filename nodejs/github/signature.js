const crypto = require('crypto')

const getBodySignature = (key, body) => {
  const hmac = crypto.createHmac('sha256', key)
  const signature = hmac.update(JSON.stringify(body)).digest('hex')
  return `sha256=${signature}` // shape in GitHub header
}

const compareSignatures = (signature, comparisonSignature) => {
  const source = Buffer.from(signature)
  const comparison = Buffer.from(comparisonSignature)
  return crypto.timingSafeEqual(source, comparison) // constant time comparison
}

/**
 * GitHub uses the key to create a hash signature with each payload and includes it in the x-hub-signature-256 header.
 * We need to validate that the request comes from GitHub using this header.
 * @param {object} {key: string, body: string , headers: object}
 * @returns boolean
 */
const verifyGithubPayload = ({ key, body, headers }) => {
  try {
    const bodySignature = getBodySignature(key, body)
    return compareSignatures(headers['x-hub-signature-256'], bodySignature)
  } catch (err) {
    console.log('verifyGithubPayload error', { error: err.message })
    return false
  }
}

/**
 * Verifies if all the required GitHub headers exist in object
 * @param {object} headers object of github headers
 * @returns boolean
 */
const verifyGithubHeadersExist = (headers) => {
  const requiredHeaders = [
    'x-hub-signature-256',
    'x-github-event',
    'x-github-hook-id',
    'x-github-hook-installation-target-type'
  ]
  return requiredHeaders.every(required => required in headers)
}

module.exports = {
  getBodySignature,
  compareSignatures,
  verifyGithubPayload,
  verifyGithubHeadersExist
}
