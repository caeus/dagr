import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { JsonLogger, serializeError } from './logging.js'

describe('JsonLogger', () => {
  it('writes one JSON record per event', () => {
    const lines: string[] = []
    const logger = new JsonLogger(
      (line) => lines.push(line),
      () => new Date('2026-08-24T12:00:00.000Z'),
    )

    logger.info('target.completed', { target: 'pkg#ci#build' })

    assert.deepEqual(JSON.parse(lines[0]!), {
      timestamp: '2026-08-24T12:00:00.000Z',
      level: 'info',
      event: 'target.completed',
      data: { target: 'pkg#ci#build' },
    })
  })

  it('does not fail on bigint or circular data', () => {
    const lines: string[] = []
    const logger = new JsonLogger((line) => lines.push(line))
    const circular: Record<string, unknown> = { count: 1n }
    circular['self'] = circular

    logger.info('odd.data', circular)

    const record = JSON.parse(lines[0]!) as { data: Record<string, unknown> }
    assert.equal(record.data['count'], '1')
    assert.equal(record.data['self'], '[Circular]')
  })
})

describe('serializeError', () => {
  it('preserves error details and enumerable context', () => {
    const error = Object.assign(new Error('failed'), { exitCode: 2, stderrTail: ['nope'] })
    const serialized = serializeError(error)

    assert.equal(serialized['name'], 'Error')
    assert.equal(serialized['message'], 'failed')
    assert.equal(serialized['exitCode'], 2)
    assert.deepEqual(serialized['stderrTail'], ['nope'])
  })
})
