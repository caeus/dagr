import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { extractFromImage } from '#runner/docker-extractor.js'
import type { ProcessRunner, ProcessResult } from '#sys/process-runner.js'

const result = (stdoutTail: readonly string[] = []): ProcessResult => ({
  command: 'docker',
  args: [],
  label: 'docker',
  exitCode: 0,
  signal: null,
  stdoutTail,
  stderrTail: [],
  durationMs: 1,
})

describe('extractFromImage', () => {
  it('merges source contents with docker cp from a stopped container', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dagr-export-'))
    const calls: string[][] = []

    try {
      await extractFromImage('pkg-ci-build', { '/out/': 'dist/' }, root, dockerRunner(calls))
      assert.deepEqual(calls, [
        ['create', 'pkg-ci-build'],
        ['cp', 'container-id:/out/.', join(root, 'dist')],
        ['rm', 'container-id'],
      ])
    } finally {
      await rm(root, { recursive: true })
    }
  })

  it('replaces an exact destination before copying', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dagr-export-'))
    const target = join(root, 'docs')
    await mkdir(target)
    await writeFile(join(target, 'stale'), 'stale')
    const calls: string[][] = []

    try {
      await extractFromImage('pkg-ci-build', { '/docs': 'docs' }, root, dockerRunner(calls))
      await assert.rejects(stat(join(target, 'stale')))
      assert.deepEqual(calls[1], ['cp', 'container-id:/docs', target])
    } finally {
      await rm(root, { recursive: true })
    }
  })

  it('places a node inside a destination directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dagr-export-'))
    const calls: string[][] = []

    try {
      await extractFromImage('pkg-ci-build', { '/bin/tool': 'build/' }, root, dockerRunner(calls))
      assert.deepEqual(calls[1], [
        'cp',
        'container-id:/bin/tool',
        join(root, 'build', 'tool'),
      ])
    } finally {
      await rm(root, { recursive: true })
    }
  })

  it('merges into the package directory for ./', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dagr-export-'))
    const calls: string[][] = []

    try {
      await extractFromImage('pkg-ci-build', { '/out/': './' }, root, dockerRunner(calls))
      assert.deepEqual(calls[1], ['cp', 'container-id:/out/.', root])
    } finally {
      await rm(root, { recursive: true })
    }
  })

  it('refuses package replacement and destination escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dagr-export-'))
    const runner = dockerRunner([])

    try {
      await assert.rejects(
        extractFromImage('image', { '/docs': '.' }, root, runner),
        /cannot replace the package directory itself/,
      )
      await assert.rejects(
        extractFromImage('image', { '/docs/': '../outside/' }, root, runner),
        /destination escapes its package directory/,
      )
    } finally {
      await rm(root, { recursive: true })
    }
  })
})

function dockerRunner(calls: string[][]): ProcessRunner {
  return {
    run: async (_command, args) => {
      calls.push([...args])
      return args[0] === 'create' ? result(['container-id']) : result()
    },
  }
}
