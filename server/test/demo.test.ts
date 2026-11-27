import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { rmTmp, tmpDir } from './helpers.ts'

const capture = fileURLToPath(new URL('../../demo/capture.mjs', import.meta.url))
const runScene = fileURLToPath(new URL('../../demo/run-scene.sh', import.meta.url))
let dir: string
let scene: string
let out: string

beforeEach(() => {
  dir = tmpDir()
  scene = path.join(dir, 'scene.json')
  out = path.join(dir, 'out')
})
afterEach(() => rmTmp(dir))

it('accepts only scene names of 1 to 64 letters, digits, underscores, or hyphens', async () => {
  const { isSceneName } = await import(new URL('../../demo/scene-names.mjs', import.meta.url).href)
  expect(isSceneName('01_Question-1')).toBe(true)
  expect(isSceneName('a'.repeat(64))).toBe(true)
  for (const name of ['../x', 'a/b', '', 'a'.repeat(65)]) expect(isSceneName(name)).toBe(false)
})

it('rejects an invalid mark before changing capture output', () => {
  const frames = path.join(out, 'frames')
  fs.mkdirSync(frames, { recursive: true })
  fs.writeFileSync(path.join(frames, 'keep.png'), 'keep')
  fs.writeFileSync(scene, JSON.stringify({ marks: [{ at: 0, name: 'first' }, { at: 1, name: '../../x' }] }))
  const result = spawnSync(process.execPath, [capture, scene, out], { encoding: 'utf8', timeout: 1500 })
  expect(fs.readdirSync(dir).sort()).toEqual(['out', 'scene.json'])
  expect(result.status).toBe(2)
  expect(result.stderr.trim().split('\n')).toHaveLength(1)
  expect(result.stderr).toContain('mark')
  expect(fs.readdirSync(out)).toEqual(['frames'])
  expect(fs.readFileSync(path.join(frames, 'keep.png'), 'utf8')).toBe('keep')
})

it('keeps capture cleanup inside the output directory', () => {
  const outside = path.join(dir, 'outside')
  fs.mkdirSync(out)
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'keep.png'), 'keep')
  fs.symlinkSync(outside, path.join(out, 'frames'), 'dir')
  fs.writeFileSync(scene, '{}')
  const result = spawnSync(process.execPath, [capture, scene, out], { encoding: 'utf8', timeout: 1500 })
  expect(fs.readdirSync(outside)).toEqual(['keep.png'])
  expect(result.status).toBe(2)
})

it('rejects an invalid scene before the demo launcher creates output', () => {
  fs.writeFileSync(scene, JSON.stringify({ marks: [{ at: 0, name: '../x' }] }))
  const result = spawnSync('bash', [runScene, scene, out], {
    encoding: 'utf8', timeout: 1500, env: { ...process.env, SIM_JS: '' },
  })
  expect(fs.existsSync(out)).toBe(false)
  expect(result.status).toBe(2)
  expect(result.stderr.trim().split('\n')).toHaveLength(1)
  expect(result.stderr).toContain('mark')
})
