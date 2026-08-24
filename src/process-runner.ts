import { spawn } from 'node:child_process'
import type { Readable } from 'node:stream'
import type { LogData, Logger } from './logging.js'

const TAIL_LINES = 100

export interface ProcessResult {
  readonly command: string
  readonly args: readonly string[]
  readonly context?: LogData
  readonly exitCode: number
  readonly signal: NodeJS.Signals | null
  readonly stdoutTail: readonly string[]
  readonly stderrTail: readonly string[]
  readonly durationMs: number
}

export interface ProcessRunner {
  run(command: string, args: readonly string[], context?: LogData): Promise<ProcessResult>
}

export class ProcessExecutionError extends Error {
  readonly command: string
  readonly args: readonly string[]
  readonly context?: LogData
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
    if (result.context) this.context = result.context
    this.exitCode = result.exitCode
    this.signal = result.signal
    this.stdoutTail = result.stdoutTail
    this.stderrTail = result.stderrTail
    this.durationMs = result.durationMs
  }
}

export function processRunner(logger: Logger): ProcessRunner {
  return { run: (command, args, context) => runProcess(command, args, logger, context) }
}

export function runProcess(
  command: string,
  args: readonly string[],
  logger: Logger,
  context?: LogData,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let failedToSpawn = false
    const stdoutTail: string[] = []
    const stderrTail: string[] = []

    const identity = context ? { command, args, context } : { command, args }
    logger.debug('process.started', identity)
    captureLines(proc.stdout, 'stdout', identity, stdoutTail, logger)
    captureLines(proc.stderr, 'stderr', identity, stderrTail, logger)

    proc.on('close', (code, signal) => {
      if (failedToSpawn) return
      const result: ProcessResult = {
        command,
        args,
        ...(context ? { context } : {}),
        exitCode: code ?? -1,
        signal,
        stdoutTail,
        stderrTail,
        durationMs: Date.now() - startedAt,
      }
      logger.debug('process.completed', {
        ...identity,
        exitCode: result.exitCode,
        signal,
        durationMs: result.durationMs,
      })
      if (result.exitCode === 0) resolve(result)
      else reject(new ProcessExecutionError(result))
    })

    proc.on('error', (error) => {
      failedToSpawn = true
      logger.error('process.spawn_failed', {
        ...identity,
        error: error.message,
        durationMs: Date.now() - startedAt,
      })
      reject(error)
    })
  })
}

function captureLines(
  stream: Readable,
  streamName: 'stdout' | 'stderr',
  identity: LogData,
  tail: string[],
  logger: Logger,
): void {
  stream.setEncoding('utf8')
  let pending = ''

  const emit = (line: string): void => {
    tail.push(line)
    if (tail.length > TAIL_LINES) tail.shift()
    logger.info('process.output', { ...identity, stream: streamName, line })
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
