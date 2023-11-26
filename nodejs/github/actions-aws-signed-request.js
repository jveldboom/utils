const axios = require('axios')
const aws4 = require('aws4')
const core = require('@actions/core')

/**
 * Send HTTP request
 * @param {Object} request object
 * @param {string} request.url full request url
 * @param {string} request.method request method eg GET, POST, PUT
 * @param {Object} request.body request body object
 * @param {String} request.region aws region name
 * @returns {Object} { body, headers, statusCode }
 */
const request = async ({ url, method, payload, region = 'us-east-2' }) => {
  const signed = signRequest({
    url,
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-github-context': process.env.GITHUB_REPOSITORY,
      'x-github-workflow': `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    },
    body: payload,
    region
  })

  const res = await axios.request({
    ...signed,
    url,
    data: payload,
    timeout: 3000
  })
  return res.data
}

/**
 * Send HTTP request with retries
 * @param {Object.} request object
 * @param {string} request.url full request url
 * @param {string} request.method request method eg GET, POST, PUT
 * @param {Array.<string>} request.headers array of request headers
 * @param {Object} request.payload request body object
 * @param {String} request.region aws region name
 * @param {Number} request.maxRetries max number of times to retry request
 * @param {Number} request.baseDelay milliseconds to base delay calculation
 * @returns response object | throws error
 */
const requestWithRetries = async ({ url, method, headers, payload, region = 'us-east-2', maxRetries = 3, baseDelay = 1000, retryCount = 0 }) => {
  try {
    return await request({ url, method, headers, payload, region })
  } catch (err) {
    ++retryCount
    if (retryCount > maxRetries) throw err

    core.info(`request failed with "${err.message}" - retry ${retryCount} / ${maxRetries}...`)
    core.info(`response: ${JSON.stringify(err?.response?.data)}`)
    await backoff(retryCount, baseDelay)
    return await requestWithRetries({ url, method, headers, payload, region, maxRetries, baseDelay, retryCount })
  }
}

/**
 * SigV4 signs a request object
 * @param {Object.} request object
 * @param {string} request.url full request url
 * @param {string} request.method request method eg GET, POST, PUT
 * @param {Array.<string>} request.headers array of request headers
 * @param {Object} request.body request body object
 * @param {String} request.service aws service name
 * @param {String} request.region aws region name
 * @returns {Object} signed request object
 */
const signRequest = ({ url, method, headers, body, service = 'execute-api', region }) => {
  const { host, pathname, search } = new URL(url)
  return aws4.sign({
    body: JSON.stringify(body),
    headers,
    host,
    method,
    path: pathname + search,
    region,
    service
  })
}

/**
 * Set a promise to resolve at set time to allow for a backoff sleep
 * @param {number} retryCount count of current retry
 * @param {number} baseDelay milliseconds to base delay calculation (retryCount * baseDelay = backoff)
 * @returns promise
 */
const backoff = (retryCount = 0, baseDelay = 500) => new Promise((resolve) => {
  const time = (1 + retryCount) * 2 * baseDelay
  setTimeout(() => resolve(time), time)
})

module.exports = {
  backoff,
  requestWithRetries,
  request,
  signRequest
}