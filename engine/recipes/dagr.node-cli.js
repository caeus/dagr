import recipe, {
  hoister,
  library,
  pnpm,
  rollup,
  typescript,
} from '//engine/recipes/typescript//dagr.recipe.js'
import { nodeBase, nodeTest } from '//engine/recipes/dagr.node-features.js'

/**
 * This repository's composition: a Node library compiled with tsc, tested with the platform runner,
 * and bundled into one file for distribution. A package using it supplies only its own pins.
 *
 * `vmModules` is on because the tests here drive `node:vm` themselves.
 */
export const nodeCli = ({ versions } = {}) => recipe([
  typescript({
    base: 'ci:node-base',
    scope: 'internal',
    versions,
    outputDirectory: 'build',
    ignore: ['.git', '.dagr', 'node_modules', 'build', 'dist', 'docs', 'coverage'],
  }),
  pnpm(),
  library({ runtime: 'node', sourceMaps: true }),
  rollup(),
  nodeBase(),
  nodeTest({ vmModules: true }),
  hoister(),
])
