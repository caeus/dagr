import { derive, value, target, scope } from '//engine/recipes/typescript//dagr.recipe.js'
import { nodeCli } from '//engine/recipes/dagr.node-cli.js'
import bootstrap from '//engine/dagr.bootstrap.json'

const SMOKE_RUN = 'mkdir -p /tmp/dagr-smoke/packages'
  + ' && HOST_OS=linux HOST_ARCH=x64 HOST_LIBC=musl REPO_ROOT=/tmp/dagr-smoke'
  + ' node --experimental-vm-modules dist/dagr.js list > /dev/null'

const versions = { ...bootstrap.dependencies, ...bootstrap.devDependencies }

const dagr = name => scope(name, {
  '/package/name': value('@caeus/dagr'),

  // A bundled CLI publishes one JavaScript file, so type declarations are dead weight.
  '/typescript/emit-declarations': value(false),

  '/source/import-alias': derive(
    { source: '/source/directory', output: '/output/directory' },
    ({ source, output }) => ({
      specifier: '#*',
      sourcePath: `./${source}/*`,
      runtimePath: `./${output}/*`,
    }),
  ),

  '/bundlecheck': target({ ignore: '/source/ignore', bundle: '/bundle' }, {
    render: (_context, { ignore, bundle }) => ({
        FROM: bundle,
        steps: [{ RUN: SMOKE_RUN }],
        IGNORE: ignore,
    }),
  }),

  '/image': target({ checked: '/bundlecheck' }, {
    render: (_context, { checked }) => ({
        FROM: 'node:22-alpine',
        steps: [
          { RUN: 'apk add --no-cache docker-cli docker-cli-buildx' },
          { WORKDIR: '/dagr' },
          { COPY: { from: checked, src: '/repo/dist/dagr.js', dest: '/dagr/dagr.js' } },
          { ENV: { REPO_ROOT: '/repo' } },
          { ENTRYPOINT: ['node', '--experimental-vm-modules', '/dagr/dagr.js'] },
        ],
        IGNORE: [],
    }),
  }),
})

/** The composition this repository builds its engine with. */
export const engine = declaration => ({
  ...nodeCli('engine', { ...declaration, versions }),
  ...dagr('engine'),
})
