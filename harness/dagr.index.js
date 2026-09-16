import engineIndexTests from '//harness/dagr.tests-engine-index.js'
import { reportOf } from '//harness/recipes//tests/dagr.testing.js'

/**
 * A package whose only content is mounts and tests. Some tests must see more than one package at
 * once — the recipe, and a composition that consumes it — and no package may reach outside itself to
 * find the other. Mounting both here keeps that dependency declared.
 *
 * The engine loads these tests, so `dagr:rdk` and `dagr:yaml` are the real builtins rather than
 * doubles and module resolution is the real one. Nothing is simulated and nothing is built: the tests
 * run while the graph expands, and the target below reports them. A failure fails only this target,
 * so a broken recipe does not take `dagr list` down with it.
 */
export default {
  ci: () => ({
    test: {
      deps: [],
      run: () => {
        const report = reportOf([engineIndexTests()])
        if (report.failed.length > 0) {
          throw new Error(`Harness tests failed:\n${report.lines.join('\n')}`)
        }
        return {
          FROM: 'alpine:3.22',
          steps: [{ RUN: `echo ${JSON.stringify(report.lines.join('\n'))}` }],
          IGNORE: ['.git'],
        }
      },
    },
  }),
}
