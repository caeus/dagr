import { spawn } from 'node:child_process'
import type { Readable } from 'node:stream'
import type { Reporter, Stream } from '#report/reporter.js'

const TAIL_LINES = 100

export interface ProcessResult {
  readonly command: string
  readonly args: readonly string[]
  readonly label: string
  readonly exitCode: number
  readonly signal: NodeJS.Signals | null
  readonly stdoutTail: readonly string[]
  readonly stderrTail: readonly string[]
  readonly durationMs: number
}

export interface ProcessRunner {
  run(command: string, args: readonly string[], label: string): Promise<ProcessResult>
}

export class ProcessExecutionError extends Error {
  readonly command: string
  readonly args: readonly string[]
  readonly label: string
  readonly exitCode: number
  readonly signal: NodeJS.Signals | null
  readonly stdoutTail: readonly string[]
  readonly stderrTail: readonly string[]
  readonly durationMs: number

  constructor(result: ProcessResult) {
    super(`${result.command} exited with code ${result.exitCode}`)
    this.name = 'ProcessExecutionError'
    this.command = result.command
    this.args = result.args
    this.label = result.label
    this.exitCode = result.exitCode
    this.signal = result.signal
    this.stdoutTail = result.stdoutTail
    this.stderrTail = result.stderrTail
    this.durationMs = result.durationMs
  }
}

export function processRunner(reporter: Reporter): ProcessRunner {
  return { run: (command, args, label) => runProcess(command, args, reporter, label) }
}

export function runProcess(
  command: string,
  args: readonly string[],
  reporter: Reporter,
  label: string,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let failedToSpawn = false
    const stdoutTail: string[] = []
    const stderrTail: string[] = []

    captureLines(proc.stdout, 'stdout', label, stdoutTail, reporter)
    captureLines(proc.stderr, 'stderr', label, stderrTail, reporter)

    proc.on('close', (code, signal) => {
      if (failedToSpawn) return
      const result: ProcessResult = {
        command,
        args,
        label,
        exitCode: code ?? -1,
        signal,
        stdoutTail,
        stderrTail,
        durationMs: Date.now() - startedAt,
      }
      if (result.exitCode === 0) resolve(result)
      else reject(new ProcessExecutionError(result))
    })

    proc.on('error', (error) => {
      failedToSpawn = true
      reject(error)
    })
  })
}

function captureLines(
  stream: Readable,
  streamName: Stream,
  label: string,
  tail: string[],
  reporter: Reporter,
): void {
  stream.setEncoding('utf8')
  let pending = ''

  const emit = (line: string): void => {
    tail.push(line)
    if (tail.length > TAIL_LINES) tail.shift()
    reporter.processLine(label, streamName, line)
  }

  stream.on('data', (chunk: string) => {
    const lines = `${pending}${chunk}`.split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) emit(line)
  })
  stream.on('end', () => {
    if (pending) emit(pending)
  })
}
