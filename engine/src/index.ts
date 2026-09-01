import { wire } from '#wire.js'
import { consoleReporter, verboseFromArgv } from '#report/reporter.js'

wire().catch((error) => {
  consoleReporter({ verbose: verboseFromArgv(process.argv.slice(2)) }).failure(error)
  process.exitCode = 1
})
