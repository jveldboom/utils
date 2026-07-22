#!/usr/bin/env node
/**
 * fetch-subtitles.js - Download the best-matching English subtitle for a video
 * from OpenSubtitles.com.
 *
 * Usage:
 *   OPENSUBTITLES_API_KEY=xxx fetch-subtitles.js <video-file> [--lang en] [--out subs.srt]
 *
 * Strategy:
 *   1. Compute the OpenSubtitles "moviehash" (64-bit hash of first+last 64KB
 *      plus file size). Exact-file match, no metadata needed.
 *   2. Query /subtitles?moviehash=...&languages=... and take the highest-rated
 *      hit that hash-matches (`moviehash_match: true`). Fall back to filename
 *      search if the hash finds nothing.
 *   3. POST /download with the chosen file_id → temporary download URL → fetch
 *      the SRT to disk.
 *
 * Get a free API key at https://www.opensubtitles.com/consumers
 */

const fs = require('fs')
const path = require('path')

const API = 'https://api.opensubtitles.com/api/v1'
const USER_AGENT = 'jveldboom-utils v1.0'

const parseArgs = (argv) => {
  const args = { lang: 'en' }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--lang') args.lang = argv[++i]
    else if (a === '--out') args.out = argv[++i]
    else if (a === '-h' || a === '--help') args.help = true
    else rest.push(a)
  }
  args.video = rest[0]
  return args
}

const usage = () => {
  console.error('Usage: OPENSUBTITLES_API_KEY=xxx fetch-subtitles.js <video-file> [--lang en] [--out subs.srt]')
  process.exit(1)
}

// OpenSubtitles moviehash: 64-bit sum of file size + first 64KB (as u64 LE) + last 64KB (as u64 LE).
// Reference: https://trac.opensubtitles.org/projects/opensubtitles/wiki/HashSourceCodes
const computeMoviehash = async (filepath) => {
  const CHUNK = 64 * 1024
  const stat = fs.statSync(filepath)
  const size = BigInt(stat.size)
  if (stat.size < CHUNK * 2) throw new Error(`File too small to hash (< ${CHUNK * 2} bytes)`)

  const fd = fs.openSync(filepath, 'r')
  try {
    const head = Buffer.alloc(CHUNK)
    const tail = Buffer.alloc(CHUNK)
    fs.readSync(fd, head, 0, CHUNK, 0)
    fs.readSync(fd, tail, 0, CHUNK, stat.size - CHUNK)

    let hash = size
    const mask = (1n << 64n) - 1n
    for (let i = 0; i < CHUNK; i += 8) {
      hash = (hash + head.readBigUInt64LE(i)) & mask
    }
    for (let i = 0; i < CHUNK; i += 8) {
      hash = (hash + tail.readBigUInt64LE(i)) & mask
    }
    return hash.toString(16).padStart(16, '0')
  } finally {
    fs.closeSync(fd)
  }
}

const apiFetch = async (url, apiKey, opts = {}) => {
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Api-Key': apiKey,
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(opts.headers || {})
    }
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`OpenSubtitles ${res.status}: ${body.slice(0, 500)}`)
  }
  return res.json()
}

// Pull the best subtitle candidate from a search response.
// Prefer hash-matched entries; break ties by download_count (proxy for community trust).
const pickBest = (data, { requireHashMatch = false } = {}) => {
  if (!data || !Array.isArray(data.data) || data.data.length === 0) return null
  let pool = data.data
  if (requireHashMatch) {
    pool = pool.filter((d) => d.attributes?.moviehash_match)
    if (pool.length === 0) return null
  }
  pool.sort((a, b) => (b.attributes?.download_count || 0) - (a.attributes?.download_count || 0))
  const chosen = pool[0]
  const file = chosen.attributes?.files?.[0]
  if (!file?.file_id) return null
  return {
    fileId: file.file_id,
    fileName: file.file_name,
    release: chosen.attributes?.release,
    downloads: chosen.attributes?.download_count,
    hashMatch: !!chosen.attributes?.moviehash_match
  }
}

const run = async () => {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.video) usage()

  const apiKey = process.env.OPENSUBTITLES_API_KEY
  if (!apiKey) {
    console.error('Error: OPENSUBTITLES_API_KEY env var is required')
    console.error('Get a free key at https://www.opensubtitles.com/consumers')
    process.exit(1)
  }
  if (!fs.existsSync(args.video)) {
    console.error(`Error: video file not found: ${args.video}`)
    process.exit(1)
  }

  const outPath = args.out || `${args.video.replace(/\.[^.]+$/, '')}.${args.lang}.srt`

  console.log(`🎬 Video:    ${args.video}`)
  console.log('🔑 Computing moviehash…')
  const hash = await computeMoviehash(args.video)
  console.log(`   hash:     ${hash}`)

  console.log(`🔎 Searching OpenSubtitles (lang=${args.lang})…`)
  let search = await apiFetch(
    `${API}/subtitles?moviehash=${hash}&languages=${encodeURIComponent(args.lang)}`,
    apiKey
  )
  let pick = pickBest(search, { requireHashMatch: true })

  if (!pick) {
    console.log('   no hash match — falling back to filename search')
    const query = encodeURIComponent(path.basename(args.video).replace(/\.[^.]+$/, ''))
    search = await apiFetch(
      `${API}/subtitles?query=${query}&languages=${encodeURIComponent(args.lang)}`,
      apiKey
    )
    pick = pickBest(search)
  }

  if (!pick) {
    console.error('❌ No subtitles found for this video.')
    process.exit(2)
  }

  console.log(`✅ Selected: ${pick.release || pick.fileName}`)
  console.log(`   file_id:  ${pick.fileId}  hash-match=${pick.hashMatch}  downloads=${pick.downloads}`)

  console.log('⬇️  Requesting download URL…')
  const dl = await apiFetch(`${API}/download`, apiKey, {
    method: 'POST',
    body: JSON.stringify({ file_id: pick.fileId })
  })
  if (!dl.link) throw new Error(`No download link in response: ${JSON.stringify(dl)}`)
  if (dl.remaining !== undefined) console.log(`   quota:    ${dl.remaining} downloads remaining today`)

  const srtRes = await fetch(dl.link)
  if (!srtRes.ok) throw new Error(`Download failed: ${srtRes.status}`)
  const srt = await srtRes.text()
  fs.writeFileSync(outPath, srt)
  console.log(`💾 Saved:    ${outPath} (${srt.length.toLocaleString()} bytes)`)
}

run().catch((err) => {
  console.error(`❌ ${err.message}`)
  process.exit(1)
})
