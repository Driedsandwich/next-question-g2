import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ACTIONS = new Set(['wait', 'end', 'session_end', 'up', 'down', 'click', 'double_click', 'long_press', 'long_press_release'])

export function isSceneName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(name)
}

export function readScene(file) {
  let scene
  try {
    scene = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    throw new Error('cannot read scene JSON')
  }
  if (!scene || typeof scene !== 'object' || Array.isArray(scene)) throw new Error('invalid scene object')
  const { automationPort, fps, scale, readyTimeoutSec, serverOffsetSec } = scene
  for (const [name, value] of Object.entries({ automationPort, fps, scale, readyTimeoutSec, serverOffsetSec })) {
    if (value != null && !Number.isFinite(value)) throw new Error(`invalid scene ${name}`)
  }
  if (automationPort != null && (!Number.isInteger(automationPort) || automationPort < 1 || automationPort > 65535)) {
    throw new Error('invalid scene automationPort')
  }
  const steps = scene.steps ?? []
  const marks = scene.marks ?? []
  if (!Array.isArray(steps) || steps.some((step) => !ACTIONS.has(step?.action) || !Number.isFinite(step.at))) {
    throw new Error('invalid scene step')
  }
  if (!Array.isArray(marks) || marks.some((mark) => !isSceneName(mark?.name))) throw new Error('invalid scene mark name')
  if (marks.some((mark) => !Number.isFinite(mark.at))) throw new Error('invalid scene mark time')

  steps.sort((a, b) => a.at - b.at)
  marks.sort((a, b) => a.at - b.at)
  const endAt = steps.find((s) => s.action === 'end')?.at ?? (steps.at(-1)?.at ?? 0) + 2
  const frameCount = Math.round(endAt * (fps ?? 6))
  if (endAt <= 0 || frameCount <= 0 || !Number.isSafeInteger(frameCount)) throw new Error('invalid scene length or frame rate')
  return { ...scene, steps, marks, endAt, frameCount }
}

function checkOutputPaths(outDir, directories, files) {
  for (const dir of ['', ...directories]) {
    const stat = fs.lstatSync(path.join(outDir, dir), { throwIfNoEntry: false })
    if (stat && !stat.isDirectory()) throw new Error(`invalid output directory: ${dir || '.'}`)
  }
  for (const file of files) {
    const stat = fs.lstatSync(path.join(outDir, file), { throwIfNoEntry: false })
    if (stat && (!stat.isFile() || stat.nlink !== 1)) throw new Error(`invalid output file: ${file}`)
  }
}

export function checkCaptureOutput(outDir, marks) {
  checkOutputPaths(outDir, ['frames', 'marks'], [
    'report.json', 'console.json', 'scene.mp4',
    ...marks.map(({ name }) => `marks/${name}.png`),
  ])
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const scene = readScene(process.argv[2])
    const outDir = path.resolve(process.argv[3])
    checkCaptureOutput(outDir, scene.marks)
    checkOutputPaths(outDir, ['pids', 'logs', 'data'], [
      'pids/all.txt', 'pids/server.pid', 'pids/vite.pid', 'pids/simulator.pid',
      'logs/stages.log', 'logs/server.log', 'logs/vite.log', 'logs/simulator.log',
      'data/pair.json', 'data/answered.jsonl', 'window.json', 'ports_during.json', 'ports_after.json',
    ])
    process.stdout.write(outDir)
  } catch (error) {
    console.error(error.message.replace(/[\r\n]+/g, ' '))
    process.exitCode = 2
  }
}
