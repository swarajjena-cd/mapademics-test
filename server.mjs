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
 */

import express from 'express'
import crypto from 'crypto'
import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Config ───────────────────────────────────────────────
const PORT = process.env.PORT || 3456
const MAPADEMICS_API_KEY = process.env.MAPADEMICS_API_KEY || 'pk_test_PtOajWu6grZat4xtjGgRTNqR'
const MAPADEMICS_BASE_URL = 'https://embedded-api-sandbox.mapademics.com/v1'

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

// ─── Start ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Mapademics POC Server running at http://localhost:${PORT}`)
  console.log(`   API Base: ${MAPADEMICS_BASE_URL}`)
  console.log(`   Auth:     access code required (default: coursedog-lmi-2026)`)
  console.log(`   Data:     loaded from data/*.json (no MongoDB needed)`)
  console.log(`\n   Open http://localhost:${PORT} in your browser\n`)
})
