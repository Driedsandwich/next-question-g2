import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkPairHeader, generateCode, loadOrCreatePairCode } from '../src/pairing.ts'
import { rmTmp, tmpDir } from './helpers.ts'

const dir = tmpDir()
afterAll(() => rmTmp(dir))

describe('pairing', () => {
  it('generates 6 digits', () => {
    for (let i = 0; i < 50; i++) expect(generateCode()).toMatch(/^\d{6}$/)
  })
  it('accepts only the exact "Pair <code>" header', () => {
    expect(checkPairHeader('Pair 123456', '123456')).toBe(true)
    expect(checkPairHeader('Pair 123457', '123456')).toBe(false)
    expect(checkPairHeader('Bearer 123456', '123456')).toBe(false)
    expect(checkPairHeader('Pair 12345', '123456')).toBe(false)
    expect(checkPairHeader(undefined, '123456')).toBe(false)
    expect(checkPairHeader('', '123456')).toBe(false)
  })
  it('saves the code and reuses it on the next start', () => {
    const a = loadOrCreatePairCode(path.join(dir, 'p'))
    expect(fs.existsSync(path.join(dir, 'p', 'pair.json'))).toBe(true)
    expect(loadOrCreatePairCode(path.join(dir, 'p'))).toBe(a)
  })
  it('replaces a corrupt pair file', () => {
    fs.mkdirSync(path.join(dir, 'q'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'q', 'pair.json'), '{nope')
    expect(loadOrCreatePairCode(path.join(dir, 'q'))).toMatch(/^\d{6}$/)
  })
})
