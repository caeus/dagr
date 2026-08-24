import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { LogData, Logger } from './logging.js'
import { ProcessExecutionError, runProcess } from './process-runner.js'

interface Event {
  readonly level: string
  readonly event: string
  readonly data?: LogData
}

function recordingLogger(events: Event[]): Logger {
  const record = (level: string) => (event: string, data?: LogData): void => {
    events.push(data ? { level, event, data } : { level, event })
  }
  return {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  }
}

describe('runProcess', () => {
  it('captures and logs stdout and stderr', async () => {
    const events: Event[] = []
    const result = await runProcess(
      process.execPath,
      ['-e', "process.stdout.write('out\\n'); process.stderr.write('err\\n')"],
      recordingLogger(events),
    )

    assert.deepEqual(result.stdoutTail, ['out'])
    assert.deepEqual(result.stderrTail, ['err'])
    assert(events.some((event) => event.event === 'process.output' && event.data?.['stream'] === 'stdout'))
    assert(events.some((event) => event.event === 'process.output' && event.data?.['stream'] === 'stderr'))
  })

  it('rejects with captured output when the process fails', async () => {
    const events: Event[] = []
    await assert.rejects(
      runProcess(
        process.execPath,
        ['-e', "process.stderr.write('broken\\n'); process.exit(7)"],
        recordingLogger(events),
      ),
      (error: unknown) => {
        assert(error instanceof ProcessExecutionError)
        assert.equal(error.exitCode, 7)
        assert.deepEqual(error.stderrTail, ['broken'])
        return true
      },
    )
  })

  it('retains only the most recent 100 lines per stream', async () => {
    const events: Event[] = []
    const result = await runProcess(
      process.execPath,
      ['-e', "for (let i = 0; i < 105; i++) console.log(i)"],
      recordingLogger(events),
    )

    assert.equal(result.stdoutTail.length, 100)
    assert.equal(result.stdoutTail[0], '5')
    assert.equal(result.stdoutTail[99], '104')
  })
})
