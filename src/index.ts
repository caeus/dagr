import { wire } from './wire.js'

wire().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
