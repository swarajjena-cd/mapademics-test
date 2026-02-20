#!/usr/bin/env node
/**
 * Mapademics POC Server (Deployable – no MongoDB required)
 *
 * - Loads program data from pre-dumped JSON files (data/*.json)
 * - Proxies Mapademics LMI API calls
 * - Protected by a hashed access code
 *
 * Usage: node server.mjs
 *
 * Environment variables:
 *   PORT                – server port (default 3456)
 *   MAPADEMICS_API_KEY  – Mapademics embedded API key
 *   ACCESS_CODE_HASH    – SHA-256 hex of the access code (override default)
 *   OPENAI_API_KEY      – (optional) OpenAI API key for AI-powered SOC matching
 */

import express from 'express'
import crypto from 'crypto'
import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Load .env file (no external dependency) ──────────────
const envPath = join(__dirname, '.env')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx < 0) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const val = trimmed.slice(eqIdx + 1).trim()
    if (!process.env[key]) process.env[key] = val
  }
  console.log('📋 Loaded .env file')
}

// ─── Config ───────────────────────────────────────────────
const PORT = process.env.PORT || 3456
const MAPADEMICS_API_KEY = process.env.MAPADEMICS_API_KEY || 'pk_test_PtOajWu6grZat4xtjGgRTNqR'
const MAPADEMICS_BASE_URL = 'https://embedded-api-sandbox.mapademics.com/v1'
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''

// Default access code: "coursedog-lmi-2026"  (share this with your team)
const ACCESS_CODE_HASH = process.env.ACCESS_CODE_HASH
  || '8ceb613bff29db6a49a14d1d411a54b234a085e2b447dbbba47f59fb9d3f5484'

const SCHOOLS = [
  { id: 'stanford', label: 'Stanford University' },
  { id: 'ufl', label: 'University of Florida' },
  { id: 'arizona', label: 'University of Arizona' },
]

// ─── Load programs from JSON ──────────────────────────────
const schoolData = {}
for (const school of SCHOOLS) {
  const filePath = join(__dirname, 'data', `${school.id}.json`)
  if (existsSync(filePath)) {
    schoolData[school.id] = JSON.parse(readFileSync(filePath, 'utf-8'))
    console.log(`📄 Loaded ${schoolData[school.id].count} programs for ${school.label}`)
  } else {
    console.warn(`⚠️  No data file for ${school.label} at ${filePath}`)
    schoolData[school.id] = { school: school.label, programs: [], count: 0 }
  }
}

// ─── Load SOC codes ──────────────────────────────────────
let socCodes = []
const socFilePath = join(__dirname, 'data', 'soc_codes.json')
if (existsSync(socFilePath)) {
  socCodes = JSON.parse(readFileSync(socFilePath, 'utf-8'))
  console.log(`📄 Loaded ${socCodes.length} SOC codes`)
}

// ─── SOC Matching Engine ─────────────────────────────────
// Builds an inverted index of keywords → SOC codes for fast matching
const socIndex = new Map()  // keyword → Set<socCode>
const socByCode = new Map() // code → socEntry

function tokenize(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w))
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
  'her', 'was', 'one', 'our', 'out', 'has', 'have', 'from', 'with', 'they',
  'been', 'this', 'that', 'will', 'each', 'make', 'like', 'than', 'them',
  'then', 'its', 'over', 'such', 'other', 'into', 'more', 'some', 'very',
  'when', 'what', 'also', 'only', 'just', 'about', 'which',
])

// Build the index
for (const soc of socCodes) {
  socByCode.set(soc.code, soc)
  const allText = `${soc.title} ${soc.majorGroup || ''} ${soc.minorGroup || ''} ${soc.broadGroup || ''}`
  const tokens = tokenize(allText)
  // Also add bigrams for better matching
  const bigrams = []
  for (let i = 0; i < tokens.length - 1; i++) {
    bigrams.push(`${tokens[i]}_${tokens[i + 1]}`)
  }
  for (const token of [...tokens, ...bigrams]) {
    if (!socIndex.has(token)) socIndex.set(token, new Set())
    socIndex.get(token).add(soc.code)
  }
}

/**
 * Local SOC matching: scores SOC codes based on keyword overlap with program data.
 * Returns top N matches sorted by relevance score.
 */
function matchSocCodes(programData, topN = 10) {
  const { name, longName, cipCode, type, degreeDesignation, college, level } = programData
  const queryText = [longName, name, type, degreeDesignation, college, level].filter(Boolean).join(' ')
  const queryTokens = tokenize(queryText)
  
  // Build bigrams from query
  const queryBigrams = []
  for (let i = 0; i < queryTokens.length - 1; i++) {
    queryBigrams.push(`${queryTokens[i]}_${queryTokens[i + 1]}`)
  }

  // Score each SOC code based on token hits
  const scores = new Map()
  for (const token of queryTokens) {
    const matches = socIndex.get(token)
    if (!matches) continue
    // IDF-like weighting: rarer keywords score higher
    const weight = Math.log(socCodes.length / matches.size)
    for (const code of matches) {
      scores.set(code, (scores.get(code) || 0) + weight)
    }
  }
  // Bigram matches get bonus score
  for (const bigram of queryBigrams) {
    const matches = socIndex.get(bigram)
    if (!matches) continue
    const weight = Math.log(socCodes.length / matches.size) * 2 // Double weight for bigrams
    for (const code of matches) {
      scores.set(code, (scores.get(code) || 0) + weight)
    }
  }

  // Also do direct title substring matching for extra precision
  const queryLower = queryText.toLowerCase()
  for (const soc of socCodes) {
    const titleLower = soc.title.toLowerCase()
    // Boost if SOC title words appear in query
    const titleTokens = tokenize(soc.title)
    let titleMatchCount = 0
    for (const t of titleTokens) {
      if (queryLower.includes(t)) titleMatchCount++
    }
    if (titleMatchCount > 0) {
      const matchRatio = titleMatchCount / titleTokens.length
      const bonus = matchRatio * 10 // Strong bonus for direct title matches
      scores.set(soc.code, (scores.get(soc.code) || 0) + bonus)
    }
  }

  // Sort by score descending and return top N
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([code, score]) => ({
      ...socByCode.get(code),
      relevanceScore: Math.round(score * 100) / 100,
    }))
}

/**
 * OpenAI-powered SOC matching (optional, if OPENAI_API_KEY is set)
 */
async function matchSocCodesWithAI(programData, topN = 10) {
  if (!OPENAI_API_KEY) return null

  const prompt = `You are an expert in occupational classification. Given the following academic program, identify the ${topN} most relevant SOC (Standard Occupational Classification) codes from the 2018 SOC system that graduates of this program would most likely pursue.

Program Information:
- Name: ${programData.longName || programData.name}
- Code: ${programData.code || 'N/A'}
- CIP Code: ${programData.cipCode || 'N/A'}
- Degree: ${programData.degreeDesignation || 'N/A'}
- Type: ${programData.type || 'N/A'}
- College: ${programData.college || 'N/A'}
- Level: ${programData.level || 'N/A'}

Return ONLY a JSON array of objects with these exact fields:
[{"code": "XX-XXXX", "title": "Occupation Title", "reason": "Brief explanation of relevance"}]

Only return valid 2018 SOC detailed occupation codes (format: XX-XXXX). No other text.`

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 1500,
      }),
    })
    const data = await response.json()
    const content = data.choices?.[0]?.message?.content || ''
    // Extract JSON from response
    const jsonMatch = content.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return null
    const aiMatches = JSON.parse(jsonMatch[0])
    // Enrich with our SOC data
    return aiMatches.map(m => {
      const local = socByCode.get(m.code)
      return {
        code: m.code,
        title: local?.title || m.title,
        majorGroup: local?.majorGroup || '',
        minorGroup: local?.minorGroup || '',
        broadGroup: local?.broadGroup || '',
        reason: m.reason,
        source: 'ai',
        verified: !!local, // true if code exists in our SOC file
      }
    })
  } catch (err) {
    console.error('OpenAI SOC matching error:', err)
    return null
  }
}

// ─── Auth helpers ─────────────────────────────────────────
function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex')
}

// Generate a random session token
function generateToken() {
  return crypto.randomBytes(32).toString('hex')
}

// In-memory session store (tokens → expiry timestamp)
const sessions = new Map()
const SESSION_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

function isValidSession(token) {
  if (!token) return false
  const expiry = sessions.get(token)
  if (!expiry) return false
  if (Date.now() > expiry) {
    sessions.delete(token)
    return false
  }
  return true
}

// ─── Express App ──────────────────────────────────────────
const app = express()
app.use(express.json())
app.use(express.static(join(__dirname, 'public')))

// ─── Auth endpoints (unprotected) ─────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { code } = req.body
  if (!code) return res.status(400).json({ error: 'Access code is required' })

  const hash = sha256(code.trim())
  if (hash !== ACCESS_CODE_HASH) {
    return res.status(401).json({ error: 'Invalid access code' })
  }

  const token = generateToken()
  sessions.set(token, Date.now() + SESSION_TTL_MS)
  res.json({ token, expiresIn: '24h' })
})

app.post('/api/auth/verify', (req, res) => {
  const token = req.headers['x-access-token'] || req.body.token
  res.json({ valid: isValidSession(token) })
})

// ─── Auth middleware for all /api/* routes below ──────────
function requireAuth(req, res, next) {
  const token = req.headers['x-access-token']
  if (!isValidSession(token)) {
    return res.status(401).json({ error: 'Unauthorized – provide a valid access token' })
  }
  next()
}

// Protect all API routes after this point
app.use('/api/schools', requireAuth)
app.use('/api/lmi', requireAuth)
app.use('/api/skills-library', requireAuth)

// ─── Schools & Programs (from JSON) ──────────────────────
app.get('/api/schools', (req, res) => {
  res.json(SCHOOLS.map(s => ({ id: s.id, label: s.label })))
})

app.get('/api/schools/:schoolId/programs', (req, res) => {
  const school = SCHOOLS.find(s => s.id === req.params.schoolId)
  if (!school) return res.status(404).json({ error: 'School not found' })
  res.json(schoolData[school.id])
})

// GET /api/schools/:schoolId/filters - Get distinct filter values for a school
app.get('/api/schools/:schoolId/filters', (req, res) => {
  const school = SCHOOLS.find(s => s.id === req.params.schoolId)
  if (!school) return res.status(404).json({ error: 'School not found' })
  const programs = schoolData[school.id]?.programs || []

  const unique = (field) => [...new Set(programs.map(p => p[field]).filter(Boolean))].sort()

  res.json({
    types: unique('type'),
    degreeDesignations: unique('degreeDesignation'),
    colleges: unique('college'),
    levels: unique('level'),
    cipCodes: unique('cipCode'),
    totalPrograms: programs.length,
  })
})

// POST /api/lmi/soc-regional-compare - Compare a SOC code across all regions
app.post('/api/lmi/soc-regional-compare', requireAuth, async (req, res) => {
  try {
    const { socCodes, regions } = req.body
    const results = await Promise.all(regions.map(async (r) => {
      const body = { socCodes, regionType: r.regionType, includeSkills: false }
      if (r.region) body.region = r.region
      const response = await fetch(`${MAPADEMICS_BASE_URL}/labor-market-intelligence/by-soc`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${MAPADEMICS_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      return response.json()
    }))
    res.json(results)
  } catch (err) {
    console.error('SOC regional compare error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ─── LMI Proxy Endpoints ─────────────────────────────────
app.post('/api/lmi/by-cip', async (req, res) => {
  try {
    const { cipCodes, regionType = 'national', region, includeSkills = true } = req.body
    if (!cipCodes || !Array.isArray(cipCodes) || cipCodes.length === 0) {
      return res.status(400).json({ error: 'cipCodes array is required' })
    }

    const body = { cipCodes, regionType, includeSkills }
    if (region) body.region = region

    const response = await fetch(`${MAPADEMICS_BASE_URL}/labor-market-intelligence/by-cip`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MAPADEMICS_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    const data = await response.json()
    res.set({
      'X-RateLimit-Limit': response.headers.get('x-ratelimit-limit'),
      'X-RateLimit-Remaining': response.headers.get('x-ratelimit-remaining'),
      'X-RateLimit-Reset': response.headers.get('x-ratelimit-reset'),
    })
    res.json(data)
  } catch (err) {
    console.error('LMI API error:', err)
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/lmi/regions', async (req, res) => {
  try {
    const url = new URL(`${MAPADEMICS_BASE_URL}/labor-market-intelligence/regions`)
    if (req.query.type) url.searchParams.set('type', req.query.type)

    const response = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${MAPADEMICS_API_KEY}` },
    })
    const data = await response.json()
    res.json(data)
  } catch (err) {
    console.error('Regions API error:', err)
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/lmi/by-soc', async (req, res) => {
  try {
    const { socCodes, regionType = 'national', region, includeSkills = true } = req.body
    const body = { socCodes, regionType, includeSkills }
    if (region) body.region = region

    const response = await fetch(`${MAPADEMICS_BASE_URL}/labor-market-intelligence/by-soc`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MAPADEMICS_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const data = await response.json()
    res.json(data)
  } catch (err) {
    console.error('LMI by SOC API error:', err)
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/lmi/compare-regions', async (req, res) => {
  try {
    const { cipCodes, regions } = req.body
    const results = await Promise.all(regions.map(async (r) => {
      const body = { cipCodes, regionType: r.regionType, includeSkills: false }
      if (r.region) body.region = r.region
      const response = await fetch(`${MAPADEMICS_BASE_URL}/labor-market-intelligence/by-cip`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${MAPADEMICS_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      return response.json()
    }))
    res.json(results)
  } catch (err) {
    console.error('Region compare error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ─── Skills Library ───────────────────────────────────────
app.get('/api/skills-library/tree', async (req, res) => {
  try {
    const response = await fetch(`${MAPADEMICS_BASE_URL}/skills-library/tree`, {
      headers: { 'Authorization': `Bearer ${MAPADEMICS_API_KEY}` },
    })
    const data = await response.json()
    res.json(data)
  } catch (err) {
    console.error('Skills Library API error:', err)
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/skills-library/:skillId', async (req, res) => {
  try {
    const response = await fetch(`${MAPADEMICS_BASE_URL}/skills-library/${req.params.skillId}`, {
      headers: { 'Authorization': `Bearer ${MAPADEMICS_API_KEY}` },
    })
    const data = await response.json()
    res.json(data)
  } catch (err) {
    console.error('Skill detail API error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ─── SOC Matching Endpoints ──────────────────────────────
app.use('/api/soc', requireAuth)

// POST /api/soc/match - Match program data to SOC codes
app.post('/api/soc/match', async (req, res) => {
  try {
    const { program, topN = 10, useAI = false } = req.body
    if (!program) return res.status(400).json({ error: 'program object is required' })

    // Local matching (always available)
    const localMatches = matchSocCodes(program, topN)

    // AI matching (optional)
    let aiMatches = null
    if (useAI && OPENAI_API_KEY) {
      aiMatches = await matchSocCodesWithAI(program, topN)
    }

    res.json({
      program: {
        name: program.longName || program.name,
        code: program.code,
        cipCode: program.cipCode,
      },
      localMatches,
      aiMatches,
      aiAvailable: !!OPENAI_API_KEY,
    })
  } catch (err) {
    console.error('SOC match error:', err)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/soc/search?q=... - Search SOC codes by keyword
app.get('/api/soc/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim()
  if (!q) return res.json({ results: [], total: socCodes.length })

  const results = socCodes.filter(s => {
    const haystack = `${s.code} ${s.title} ${s.majorGroup} ${s.minorGroup} ${s.broadGroup}`.toLowerCase()
    return q.split(/\s+/).every(word => haystack.includes(word))
  }).slice(0, 50)

  res.json({ results, total: results.length, query: q })
})

// GET /api/soc/all - Get all SOC codes (for client-side search)
app.get('/api/soc/all', (req, res) => {
  res.json({ data: socCodes, total: socCodes.length })
})

// POST /api/soc/match-and-fetch - Match SOC codes AND fetch LMI in one call
app.post('/api/soc/match-and-fetch', async (req, res) => {
  try {
    const { program, topN = 5, regionType = 'national', region, useAI = false } = req.body
    if (!program) return res.status(400).json({ error: 'program object is required' })

    // Step 1: Match SOC codes
    let matches = matchSocCodes(program, topN)
    if (useAI && OPENAI_API_KEY) {
      const ai = await matchSocCodesWithAI(program, topN)
      if (ai) matches = ai
    }

    const socCodeList = matches.map(m => m.code)

    // Step 2: Fetch LMI for matched SOC codes
    const body = { socCodes: socCodeList, regionType, includeSkills: true }
    if (region) body.region = region

    const lmiResponse = await fetch(`${MAPADEMICS_BASE_URL}/labor-market-intelligence/by-soc`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MAPADEMICS_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const lmiData = await lmiResponse.json()

    // Merge match data with LMI data
    const occupations = lmiData.data?.matchedOccupations || []
    const enrichedMatches = matches.map(m => {
      const occ = occupations.find(o => o.socCode === m.code)
      return {
        ...m,
        lmiData: occ || null,
        hasLMI: !!occ,
        // Flatten key LMI fields for easy access
        ...(occ?.laborMarketData ? {
          medianSalary: occ.laborMarketData.medianAnnualSalary,
          totalEmployment: occ.laborMarketData.totalEmployment,
          growthRate: occ.laborMarketData.forecastedEmploymentGrowth,
          demandScore: occ.laborMarketData.demand?.score,
          demandFactors: occ.laborMarketData.demand?.factors,
          degreeLevel: occ.laborMarketData.typicalDegreeLevel,
        } : {}),
      }
    })

    res.json({
      program: { name: program.longName || program.name, code: program.code, cipCode: program.cipCode },
      matches: enrichedMatches,
      lmiRaw: lmiData,
      warnings: lmiData.data?.warnings || [],
      aiAvailable: !!OPENAI_API_KEY,
    })
  } catch (err) {
    console.error('SOC match-and-fetch error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ─── Start ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Mapademics POC Server running at http://localhost:${PORT}`)
  console.log(`   API Base: ${MAPADEMICS_BASE_URL}`)
  console.log(`   Auth:     access code required (default: coursedog-lmi-2026)`)
  console.log(`   Data:     loaded from data/*.json (no MongoDB needed)`)
  console.log(`\n   Open http://localhost:${PORT} in your browser\n`)
})
