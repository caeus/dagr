export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogData = Readonly<Record<string, unknown>>

export interface Logger {
  debug(event: string, data?: LogData): void
  info(event: string, data?: LogData): void
  warn(event: string, data?: LogData): void
  error(event: string, data?: LogData): void
}

export interface LogRecord {
  readonly timestamp: string
  readonly level: LogLevel
  readonly event: string
  readonly data?: LogData
}

type Sink = (line: string) => void
type Clock = () => Date

export class JsonLogger implements Logger {
  constructor(
    private readonly sink: Sink,
    private readonly clock: Clock = () => new Date(),
  ) {}

  debug(event: string, data?: LogData): void {
    this.write('debug', event, data)
  }

  info(event: string, data?: LogData): void {
    this.write('info', event, data)
  }

  warn(event: string, data?: LogData): void {
    this.write('warn', event, data)
  }

  error(event: string, data?: LogData): void {
    this.write('error', event, data)
  }

  private write(level: LogLevel, event: string, data?: LogData): void {
    const record: LogRecord = data
      ? { timestamp: this.clock().toISOString(), level, event, data }
      : { timestamp: this.clock().toISOString(), level, event }
    this.sink(stringify(record))
  }
}

export const logger = new JsonLogger((line) => process.stderr.write(`${line}\n`))

export function serializeError(
  error: unknown,
  seen: WeakSet<object> = new WeakSet(),
): Readonly<Record<string, unknown>> {
  if (!(error instanceof Error)) return { value: error }
  if (seen.has(error)) return { circular: true }
  seen.add(error)

  const details: Record<string, unknown> = {
    name: error.name,
    message: error.message,
  }
  if (error.stack) details['stack'] = error.stack
  if (error.cause !== undefined) details['cause'] = serializeError(error.cause, seen)
  Object.assign(details, Object.fromEntries(Object.entries(error)))
  return details
}

function stringify(value: unknown): string {
  const seen = new WeakSet<object>()
  return JSON.stringify(value, (_key, nested) => {
    if (typeof nested === 'bigint') return nested.toString()
    if (typeof nested !== 'object' || nested === null) return nested
    if (seen.has(nested)) return '[Circular]'
    seen.add(nested)
    return nested
  }) ?? 'null'
}
