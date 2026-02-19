#!/usr/bin/env node
/**
 * Dump programs from MongoDB into JSON files for each school.
 * This removes the MongoDB dependency for the deployed server.
 * 
 * Usage: node dump-programs.mjs
 */

import { MongoClient } from 'mongodb'
import { writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MONGO_URI = process.env.DATABASE_URI || 'mongodb://localhost'

const SCHOOLS = [
  { id: 'stanford', db: 'stanford', label: 'Stanford University' },
  { id: 'ufl', db: 'ufl_peoplesoft_direct', label: 'University of Florida' },
  { id: 'arizona', db: 'arizona_peoplesoft', label: 'University of Arizona' },
]

async function main() {
  const client = new MongoClient(MONGO_URI)
  await client.connect()
  console.log('✅ Connected to MongoDB')

  const dataDir = join(__dirname, 'data')
  mkdirSync(dataDir, { recursive: true })

  for (const school of SCHOOLS) {
    console.log(`\n📦 Dumping programs for ${school.label} (db: ${school.db})...`)
    const db = client.db(school.db)

    const programs = await db.collection('programs').aggregate([
      { $match: { cipCode: { $exists: true, $ne: '' }, status: 'Active' } },
      { $sort: { _id: -1 } },
      { $group: {
        _id: '$code',
        name: { $first: '$name' },
        longName: { $first: '$longName' },
        code: { $first: '$code' },
        cipCode: { $first: '$cipCode' },
        type: { $first: '$type' },
        level: { $first: '$level' },
        college: { $first: '$college' },
        degreeDesignation: { $first: '$degreeDesignation' },
        status: { $first: '$status' },
      }},
      { $sort: { name: 1 } },
    ]).toArray()

    const output = { school: school.label, programs, count: programs.length }
    const filePath = join(dataDir, `${school.id}.json`)
    writeFileSync(filePath, JSON.stringify(output, null, 2))
    console.log(`   ✅ ${programs.length} programs → ${filePath}`)
  }

  await client.close()
  console.log('\n🎉 Done! Programs dumped to data/ directory.\n')
}

main().catch(err => {
  console.error('Failed:', err)
  process.exit(1)
})
