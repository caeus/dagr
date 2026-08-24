import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import type { ProcessRunner } from '../process-runner.js'
import { buildDockerImage } from './docker-builder.js'

describe('buildDockerImage', () => {
  it('uses plain progress and structured image-build context', async () => {
    const calls: Parameters<ProcessRunner['run']>[] = []
    const runner: ProcessRunner = {
      run: async (...args) => {
        calls.push(args)
        const iidIndex = args[1].indexOf('--iidfile')
        assert.notEqual(iidIndex, -1)
        await writeFile(args[1][iidIndex + 1]!, 'sha256:test')
        return {
          command: args[0],
          args: args[1],
          ...(args[2] ? { context: args[2] } : {}),
          exitCode: 0,
          signal: null,
          stdoutTail: [],
          stderrTail: [],
          durationMs: 1,
        }
      },
    }

    const result = await buildDockerImage(
      'FROM scratch\n',
      'pkg-ci-build',
      '/repo/pkg',
      [],
      runner,
    )

    assert.equal(result.digest, 'sha256:test')
    assert(calls[0]?.[1].includes('--progress=plain'))
    assert.deepEqual(calls[0]?.[2], {
      operation: 'image.build',
      imageTag: 'pkg-ci-build',
      contextPath: '/repo/pkg',
    })
  })
})
