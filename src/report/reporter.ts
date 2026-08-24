import { ProcessExecutionError } from '#sys/process-runner.js'

export type Stream = 'stdout' | 'stderr'

export interface Reporter {
  targetStarted(fqt: string): void
  targetCompleted(fqt: string, durationMs: number): void
  targetFailed(fqt: string, durationMs: number): void
  processLine(label: string, stream: Stream, line: string): void
  failure(error: unknown): void
}

export interface ReporterOptions {
  readonly verbose: boolean
  readonly color: boolean
}

type Sink = (line: string) => void

const GREEN = '\u001b[32m'
const RED = '\u001b[31m'
const DIM = '\u001b[2m'
const RESET = '\u001b[0m'

export class ConsoleReporter implements Reporter {
  constructor(
    private readonly sink: Sink,
    private readonly options: ReporterOptions,
  ) {}

  targetStarted(fqt: string): void {
    this.sink(`  ${this.paint('▶', DIM)} ${fqt}`)
  }

  targetCompleted(fqt: string, durationMs: number): void {
    this.sink(`  ${this.paint('✓', GREEN)} ${fqt}  ${this.paint(duration(durationMs), DIM)}`)
  }

  targetFailed(fqt: string, durationMs: number): void {
    this.sink(`  ${this.paint('✗', RED)} ${fqt}  ${this.paint(duration(durationMs), DIM)}`)
  }

  processLine(label: string, _stream: Stream, line: string): void {
    if (!this.options.verbose) return
    this.sink(`${this.paint(label, DIM)} │ ${line}`)
  }

  failure(error: unknown): void {
    if (error instanceof ProcessExecutionError) {
      this.sink(`${this.paint('error:', RED)} ${error.message}`)
      const tail = error.stderrTail.length > 0 ? error.stderrTail : error.stdoutTail
      for (const line of tail) this.sink(`  ${line}`)
      if (!this.options.verbose)
        this.sink(this.paint('  (rerun with --verbose for full output)', DIM))
      return
    }

    if (!(error instanceof Error)) {
      this.sink(`${this.paint('error:', RED)} ${String(error)}`)
      return
    }

    this.sink(`${this.paint('error:', RED)} ${error.message}`)
    for (let cause = error.cause; cause instanceof Error; cause = cause.cause)
      this.sink(this.paint(`  caused by: ${cause.message}`, DIM))
  }

  private paint(text: string, code: string): string {
    return this.options.color ? `${code}${text}${RESET}` : text
  }
}

function duration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

// The entrypoint reports failures that escape before a parsed command is available, so it reads
// verbosity straight off argv. The parsed flag in wire.ts stays authoritative for everything else.
export const verboseFromArgv = (argv: readonly string[]): boolean =>
  argv.includes('-v') || argv.includes('--verbose')

export const consoleReporter = (options: { verbose: boolean }): Reporter =>
  new ConsoleReporter((line) => process.stderr.write(`${line}\n`), {
    verbose: options.verbose,
    color: process.stderr.isTTY === true,
  })
