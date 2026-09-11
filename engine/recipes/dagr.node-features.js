import {
  command,
  fact,
  rdk,
  requirement,
  runSteps,
  target,
} from '//engine/recipes/typescript//dagr.recipe.js'

/**
 * Features this repository composes on top of the published TypeScript recipe. They live beside the
 * mount rather than inside it so a convention can prove itself here before anyone else inherits it.
 */

/**
 * A base image with Node and a package manager, which `typescript({ base })` otherwise expects every
 * project to hand-roll. Reference it as `'ci:node-base'`: the qualified form resolves from any facet,
 * and the dev install target depends on the base from `dev`.
 */
export function nodeBase({
  name = 'node-base',
  image = 'node:22-alpine',
  packageManager = 'pnpm@11.20.0',
} = {}) {
  return rdk.graph({
    [`/target/ci/${name}`]: target({}, {
      render: () => ({
        deps: [],
        run: () => ({
          FROM: image,
          steps: [
            { RUN: `corepack enable && corepack prepare ${packageManager} --activate` },
            { WORKDIR: '/repo' },
          ],
          IGNORE: [],
        }),
      }),
    }),
  })
}

/**
 * Tests with the platform test runner over TypeScript sources, as an alternative to `vitest()`.
 * `vmModules` is only for suites that use `node:vm` themselves.
 */
export function nodeTest({
  pattern = 'src/**/*.test.ts',
  vmModules = false,
  sourceMaps = true,
} = {}) {
  const invocation = [
    'node',
    ...(vmModules ? ['--experimental-vm-modules'] : []),
    ...(sourceMaps ? ['--enable-source-maps'] : []),
    '--import tsx/esm',
    '--test',
    '--test-reporter=spec',
    `'${pattern}'`,
  ].join(' ')

  return rdk.graph({
    // Every development intent, not just `test`: the target below runs in the image `build` produced,
    // so tsx has to be in the manifest that image installed. esbuild is tsx's own build step.
    '/requirement/node-test': requirement({
      packages: ['tsx'],
    }),
    '/requirement/build-scripts/node-test': fact({}, {
      for: ['dev', 'typecheck', 'test', 'lint', 'docs', 'build'],
      value: ['esbuild'],
    }),
    '/command/test/node': command({ requirement: rdk.one('/requirement/node-test') }, {
      for: ['test'],
      run: () => ({ shell: invocation }),
    }),
    '/target/ci/test': target({
      ignore: rdk.one('/source/ignore'),
      exec: rdk.one('/package-manager/exec'),
    }, {
      render: (context, { ignore, exec }) => ({
        deps: ['build'],
        run: ({ images }) => ({
          FROM: images.build,
          steps: runSteps(context.invocations(), exec),
          IGNORE: ignore,
        }),
      }),
    }),
  })
}
