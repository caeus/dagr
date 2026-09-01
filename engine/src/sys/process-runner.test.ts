import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Reporter, Stream } from '#report/reporter.js'
import { ProcessExecutionError, runProcess } from '#sys/process-runner.js'

interface Line {
  readonly label: string
  readonly stream: Stream
  readonly line: string
}

function recordingReporter(lines: Line[]): Reporter {
  return {
    targetStarted: () => undefined,
    targetCompleted: () => undefined,
    targetFailed: () => undefined,
    processLine: (label, stream, line) => lines.push({ label, stream, line }),
    failure: () => undefined,
  }
}

describe('runProcess', () => {
  it('captures stdout and stderr and reports every line', async () => {
    const lines: Line[] = []
    const result = await runProcess(
      process.execPath,
      ['-e', "process.stdout.write('out\\n'); process.stderr.write('err\\n')"],
      recordingReporter(lines),
      'test.run',
    )

    assert.deepEqual(result.stdoutTail, ['out'])
    assert.deepEqual(result.stderrTail, ['err'])
    assert(lines.some((l) => l.stream === 'stdout' && l.line === 'out' && l.label === 'test.run'))
    assert(lines.some((l) => l.stream === 'stderr' && l.line === 'err'))
  })

  it('rejects with captured output when the process fails', async () => {
    await assert.rejects(
      runProcess(
        process.execPath,
        ['-e', "process.stderr.write('broken\\n'); process.exit(7)"],
        recordingReporter([]),
        'test.run',
      ),
      (error: unknown) => {
        assert(error instanceof ProcessExecutionError)
        assert.equal(error.exitCode, 7)
        assert.equal(error.label, 'test.run')
        assert.deepEqual(error.stderrTail, ['broken'])
        return true
      },
    )
  })

  it('retains only the most recent 100 lines per stream', async () => {
    const result = await runProcess(
      process.execPath,
      // Raw writes, not console.log: console.log formats through util.inspect, which colorizes
      // numbers when FORCE_COLOR is set in the environment, ANSI codes and all.
      ['-e', 'for (let i = 0; i < 105; i++) process.stdout.write(`${i}\\n`)'],
      recordingReporter([]),
      'test.run',
    )

    assert.equal(result.stdoutTail.length, 100)
    assert.equal(result.stdoutTail[0], '5')
    assert.equal(result.stdoutTail[99], '104')
  })

  it('rejects when the command cannot be spawned', async () => {
    await assert.rejects(
      runProcess('definitely-not-a-real-binary', [], recordingReporter([]), 'test.run'),
      /ENOENT/,
    )
  })
})
