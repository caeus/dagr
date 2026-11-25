import { hoister, library, pnpm, rollup, typescript } from '//engine/recipes/typescript//dagr.recipe.js'
import { nodeBase, nodeTest } from '//engine/recipes/dagr.node-features.js'

export const nodeCli = (name, declaration) => ({
  ...typescript(name, {
    outputDirectory: 'build',
    ignore: ['.git', '.dagr', 'node_modules', 'build', 'dist', 'docs', 'coverage'],
    ...declaration,
  }),
  ...pnpm(name),
  ...library(name, { runtime: 'node', sourceMaps: true }),
  ...rollup(name),
  ...nodeBase(name),
  ...nodeTest(name, { vmModules: true }),
  ...hoister(name),
})
