#!/usr/bin/env node
/**
 * subtitles-to-cuts.js - Turn an SRT + regex wordlist into a cuts file that
 * ffmpeg/remove-cuts.sh understands.
 *
 * Usage:
 *   subtitles-to-cuts.js <subs.srt> [--words swear-words.json] [--pad 0.3]
 *                                   [--merge-gap 1.5] [--out cuts.txt]
 *
 * Wordlist is a JSON array of regex fragments (e.g. "fuck.*", "holy shit").
 * They're joined with | and wrapped in \b(?:...)\b so matches are word-bounded
 * and case-insensitive — same approach as video-swear-jar.
 *
 * Each match snaps to that subtitle line's start/end, pads by --pad seconds on
 * each side, then merges neighbors whose gap is under --merge-gap seconds so
 * you don't end up with choppy back-to-back cuts.
 *
 * Output is annotated so you can eyeball what will be cut before running
 * remove-cuts.sh — comments name the matched terms and quote the line.
 */

const fs = require('fs')
const path = require('path')

const DEFAULT_WORDS = path.join(__dirname, 'swear-words.json')

const parseArgs = (argv) => {
  const args = { pad: 0.3, mergeGap: 1.5, words: DEFAULT_WORDS }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--words') args.words = argv[++i]
    else if (a === '--pad') args.pad = parseFloat(argv[++i])
    else if (a === '--merge-gap') args.mergeGap = parseFloat(argv[++i])
    else if (a === '--out') args.out = argv[++i]
    else if (a === '-h' || a === '--help') args.help = true
    else rest.push(a)
  }
  args.srt = rest[0]
  return args
}

const usage = () => {
  console.error('Usage: subtitles-to-cuts.js <subs.srt> [--words file.json] [--pad 0.3] [--merge-gap 1.5] [--out cuts.txt]')
  process.exit(1)
}

// "HH:MM:SS,mmm" (or ".mmm") → seconds
const srtTimeToSec = (s) => {
  const [h, m, rest] = s.split(':')
  const [sec, ms = '0'] = rest.replace(',', '.').split('.')
  return (+h) * 3600 + (+m) * 60 + (+sec) + (+ms) / 1000
}

const secToTs = (sec) => {
  if (sec < 0) sec = 0
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec - h * 3600 - m * 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`
}

// SRT parser — blocks separated by blank lines. Tolerates missing indices and
// stray whitespace; skips any block without a valid timestamp line.
const parseSrt = (text) => {
  const blocks = text.replace(/^﻿/, '').split(/\r?\n\r?\n+/)
  const entries = []
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    if (lines.length < 2) continue
    const tsLine = lines.find((l) => /\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(l))
    if (!tsLine) continue
    const [startStr, endStr] = tsLine.split('-->').map((s) => s.trim())
    const start = srtTimeToSec(startStr)
    const end = srtTimeToSec(endStr)
    // Strip common SRT/ASS tags so <i>, {\an8}, etc. don't produce weird matches.
    const textLines = lines
      .slice(lines.indexOf(tsLine) + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\{[^}]+\}/g, '')
      .trim()
    if (!textLines) continue
    entries.push({ start, end, text: textLines })
  }
  return entries
}

// Build one regex per pattern so we can report which pattern matched (rather
// than the greedy matched substring — "fuck.*" would otherwise label as
// "fuck is going on" instead of "fuck.*").
const buildRegexes = (patterns) => patterns.map((p) => ({
  pattern: p,
  regex: new RegExp(`\\b(?:${p})\\b`, 'i')
}))

const findMatches = (entries, regexes) => {
  const cuts = []
  for (const e of entries) {
    const hits = []
    for (const { pattern, regex } of regexes) {
      if (regex.test(e.text)) hits.push(pattern)
    }
    if (hits.length) cuts.push({ start: e.start, end: e.end, text: e.text, hits })
  }
  return cuts
}

// Merges cuts whose gap (next.start - prev.end) is <= mergeGap. Assumes input
// is sorted by start — SRTs are, and matches are collected in order.
const merge = (cuts, mergeGap) => {
  const out = []
  for (const c of cuts) {
    const last = out[out.length - 1]
    if (last && c.start - last.end <= mergeGap) {
      last.end = Math.max(last.end, c.end)
      last.hits = [...new Set([...last.hits, ...c.hits])]
      last.merged = (last.merged || 1) + 1
      last.text = `${last.text} | ${c.text}`
    } else {
      out.push({ ...c })
    }
  }
  return out
}

const run = () => {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.srt) usage()
  if (!fs.existsSync(args.srt)) {
    console.error(`Error: SRT not found: ${args.srt}`)
    process.exit(1)
  }
  if (!fs.existsSync(args.words)) {
    console.error(`Error: wordlist not found: ${args.words}`)
    process.exit(1)
  }

  const patterns = JSON.parse(fs.readFileSync(args.words, 'utf8'))
  if (!Array.isArray(patterns) || patterns.length === 0) {
    console.error('Error: wordlist must be a non-empty JSON array of regex patterns')
    process.exit(1)
  }
  const regexes = buildRegexes(patterns)

  const srt = fs.readFileSync(args.srt, 'utf8')
  const entries = parseSrt(srt)
  console.log(`📖 Parsed ${entries.length} subtitle entries from ${args.srt}`)

  const raw = findMatches(entries, regexes)
  console.log(`🎯 Matched ${raw.length} subtitle line(s) against ${patterns.length} pattern(s)`)

  // Apply pad, then merge — padding first so merges account for pad-induced overlap.
  const padded = raw.map((c) => ({ ...c, start: Math.max(0, c.start - args.pad), end: c.end + args.pad }))
  const merged = merge(padded, args.mergeGap)
  console.log(`🔗 Merged into ${merged.length} cut(s) (gap ≤ ${args.mergeGap}s)`)

  const outPath = args.out || `${args.srt.replace(/\.[^.]+$/, '')}.cuts.txt`
  const lines = [
    `# Generated from ${path.basename(args.srt)}`,
    `# pad=${args.pad}s  merge-gap=${args.mergeGap}s  patterns=${patterns.length}`,
    `# Review each cut, then run: remove-cuts.sh <video> ${path.basename(outPath)}`,
    ''
  ]
  for (const c of merged) {
    const tag = c.merged ? `merged ${c.merged}, ` : ''
    const hits = c.hits.join(', ')
    const preview = c.text.length > 120 ? `${c.text.slice(0, 117)}...` : c.text
    lines.push(`# [${tag}${hits}] "${preview}"`)
    lines.push(`${secToTs(c.start)} - ${secToTs(c.end)}`)
    lines.push('')
  }
  fs.writeFileSync(outPath, lines.join('\n'))
  console.log(`💾 Wrote ${outPath}`)
}

run()
