import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ConsoleReporter } from '#report/reporter.js'
import { ProcessExecutionError } from '#sys/process-runner.js'

const reporter = (options: { verbose?: boolean } = {}): { lines: string[]; reporter: ConsoleReporter } => {
  const lines: string[] = []
  return {
    lines,
    reporter: new ConsoleReporter((line) => lines.push(line), {
      verbose: options.verbose ?? false,
      color: false,
    }),
  }
}

const processError = (overrides: Partial<{ stderrTail: string[]; stdoutTail: string[] }> = {}) =>
  new ProcessExecutionError({
    command: 'docker',
    args: ['buildx', 'build'],
    label: 'image.build pkg-ci-build',
    exitCode: 1,
    signal: null,
    stdoutTail: overrides.stdoutTail ?? [],
    stderrTail: overrides.stderrTail ?? ['#8 ERROR: process "pnpm build" did not complete'],
    durationMs: 3200,
  })

describe('ConsoleReporter', () => {
  it('marks a target as started and completed', () => {
    const { lines, reporter: r } = reporter()

    r.targetStarted('//pkg:ci:build')
    r.targetCompleted('//pkg:ci:build', 4100)

    assert.deepEqual(lines, ['  ▶ //pkg:ci:build', '  ✓ //pkg:ci:build  4.1s'])
  })

  it('marks a target as failed', () => {
    const { lines, reporter: r } = reporter()

    r.targetFailed('//pkg:ci:build', 3200)

    assert.deepEqual(lines, ['  ✗ //pkg:ci:build  3.2s'])
  })

  it('renders sub-second durations in milliseconds', () => {
    const { lines, reporter: r } = reporter()

    r.targetCompleted('//pkg:ci:build', 840)

    assert.equal(lines[0], '  ✓ //pkg:ci:build  840ms')
  })

  it('stays silent about process output unless verbose', () => {
    const { lines, reporter: r } = reporter()

    r.processLine('image.build pkg-ci-build', 'stdout', '#8 [4/4] RUN pnpm build')

    assert.deepEqual(lines, [])
  })

  it('prefixes process output with its label when verbose', () => {
    const { lines, reporter: r } = reporter({ verbose: true })

    r.processLine('image.build pkg-ci-build', 'stdout', '#8 [4/4] RUN pnpm build')

    assert.deepEqual(lines, ['image.build pkg-ci-build │ #8 [4/4] RUN pnpm build'])
  })

  it('prints the captured stderr tail when a process fails', () => {
    const { lines, reporter: r } = reporter()

    r.failure(processError())

    assert.equal(lines[0], 'error: docker exited with code 1')
    assert.equal(lines[1], '  #8 ERROR: process "pnpm build" did not complete')
    assert.match(lines[2]!, /--verbose/)
  })

  it('falls back to the stdout tail when stderr captured nothing', () => {
    const { lines, reporter: r } = reporter()

    r.failure(processError({ stderrTail: [], stdoutTail: ['boom'] }))

    assert.equal(lines[1], '  boom')
  })

  it('omits the verbose hint when already verbose', () => {
    const { lines, reporter: r } = reporter({ verbose: true })

    r.failure(processError())

    assert.equal(lines.length, 2)
  })

  it('walks the cause chain of an ordinary error', () => {
    const { lines, reporter: r } = reporter()

    r.failure(new Error('could not load packages', { cause: new Error('bad dagr.index.js') }))

    assert.deepEqual(lines, [
      'error: could not load packages',
      '  caused by: bad dagr.index.js',
    ])
  })

  it('reports a thrown non-error', () => {
    const { lines, reporter: r } = reporter()

    r.failure('just a string')

    assert.deepEqual(lines, ['error: just a string'])
  })
})
