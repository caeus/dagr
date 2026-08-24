import { wire } from './wire.js'
import { logger, serializeError } from './logging.js'

wire().catch((error) => {
  logger.error('dagr.failed', { error: serializeError(error) })
  process.exitCode = 1
})
