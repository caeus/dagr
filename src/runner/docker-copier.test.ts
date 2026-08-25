import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { copyFromImage } from '#runner/docker-copier.js'
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

describe('copyFromImage', () => {
  it('copies from a created, never-started container and removes it', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'dagr-copy-'))
    const calls: Array<{ args: readonly string[]; label: string }> = []
    const runner: ProcessRunner = {
      run: async (_command, args, label) => {
        calls.push({ args, label })
        return args[0] === 'create' ? result(['container-id']) : result()
      },
    }

    try {
      await copyFromImage('tools:latest', [{ src: '/dagr/.', dest }], runner)
      assert.deepEqual(calls, [
        { args: ['create', 'tools:latest'], label: 'container.create tools:latest' },
        { args: ['cp', 'container-id:/dagr/.', dest], label: 'container.copy tools:latest' },
        { args: ['rm', 'container-id'], label: 'container.remove tools:latest' },
      ])
    } finally {
      await rm(dest, { recursive: true })
    }
  })

  it('removes the temporary container when copying fails', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'dagr-copy-'))
    const calls: string[] = []
    const runner: ProcessRunner = {
      run: async (_command, args) => {
        calls.push(args[0]!)
        if (args[0] === 'create') return result(['container-id'])
        if (args[0] === 'cp') throw new Error('copy failed')
        return result()
      },
    }

    try {
      await assert.rejects(
        copyFromImage('tools:latest', [{ src: '/dagr/.', dest }], runner),
        /copy failed/,
      )
      assert.deepEqual(calls, ['create', 'cp', 'rm'])
    } finally {
      await rm(dest, { recursive: true })
    }
  })
})
