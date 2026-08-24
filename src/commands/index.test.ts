import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { DockerImageExtractor } from '../wire.js'
import type { LogData, Logger } from '../logging.js'
import type { Runner } from '../runner/index.js'
import { parseCmd, RunCommandRunner } from './index.js'

describe('parseCmd', () => {
  it('accepts multiple run targets', () => {
    assert.deepEqual(
      parseCmd(['run', 'packages/a#ci#test', 'packages/b#ci#test']),
      {
        command: 'run',
        fqts: ['packages/a#ci#test', 'packages/b#ci#test']
      }
    )
  })
})

describe('RunCommandRunner', () => {
  it('runs every target and applies package context to each one', async () => {
    const ran: string[] = []
    const completed: LogData[] = []
    const runner: Runner = async (fqt) => {
      ran.push(fqt.toString())
      return {
        fqt,
        imageTag: fqt.toString().replaceAll('#', '-'),
        imageDigest: 'sha256:test'
      }
    }
    const extractor: DockerImageExtractor = {
      extractFromImage: async () => undefined
    }
    const logger: Logger = {
      debug: () => undefined,
      info: (event, data) => {
        if (event === 'target.completed' && data) completed.push(data)
      },
      warn: () => undefined,
      error: () => undefined,
    }

    await new RunCommandRunner(
      runner,
      extractor,
      '/',
      'packages/ui',
      logger,
    ).execute({ command: 'run', fqts: ['ci#lint', 'ci#test'] })

    assert.deepEqual(ran, ['packages/ui#ci#lint', 'packages/ui#ci#test'])
    assert.deepEqual(completed.map((data) => data['target']), ran)
  })
})
