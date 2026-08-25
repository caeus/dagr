import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { inspectImageWorkdir } from '#runner/docker-inspector.js'
import type { ProcessRunner, ProcessResult } from '#sys/process-runner.js'

const result = (stdoutTail: readonly string[]): ProcessResult => ({
  command: 'docker',
  args: [],
  label: 'image.inspect test',
  exitCode: 0,
  signal: null,
  stdoutTail,
  stderrTail: [],
  durationMs: 1,
})

describe('inspectImageWorkdir', () => {
  it('reads the image working directory', async () => {
    const runner: ProcessRunner = { run: async () => result(['"/dagr"']) }
    assert.equal(await inspectImageWorkdir('test', runner), '/dagr')
  })

  it('uses / when the image has no configured working directory', async () => {
    const runner: ProcessRunner = { run: async () => result(['""']) }
    assert.equal(await inspectImageWorkdir('test', runner), '/')
  })
})
