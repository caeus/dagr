import { rdk, target } from '//engine/recipes/typescript//dagr.recipe.js'
import { nodeCli } from '//engine/recipes/dagr.node-cli.js'

const SMOKE_RUN = 'mkdir -p /tmp/dagr-smoke/packages'
  + ' && HOST_OS=linux HOST_ARCH=x64 HOST_LIBC=musl REPO_ROOT=/tmp/dagr-smoke'
  + ' node --experimental-vm-modules dist/dagr.js list > /dev/null'

const versions = {
  '@caeus/wyr': '0.0.0-rc1',
  '@optique/core': '1.2.0',
  '@optique/run': '1.2.0',
  'smol-toml': '1.7.0',
  tsx: '4.23.7',
  yaml: '2.8.3',
  zod: '4.4.3',
}

const dagr = rdk.graph({
  '/package/name': rdk.value('@caeus/dagr'),

  // A bundled CLI publishes one JavaScript file, so type declarations are dead weight.
  '/typescript/emit-declarations': rdk.value(false),

  '/source/import-alias': rdk.derive(
    { source: rdk.one('/source/directory'), output: rdk.one('/output/directory') },
    ({ source, output }) => ({
      specifier: '#*',
      sourcePath: `./${source}/*`,
      runtimePath: `./${output}/*`,
    }),
  ),

  '/target/ci/bundlecheck': target({ ignore: rdk.one('/source/ignore') }, {
    render: (_context, { ignore }) => ({
      deps: ['ci:bundle'],
      run: ({ images }) => ({
        FROM: images['ci:bundle'],
        steps: [{ RUN: SMOKE_RUN }],
        IGNORE: ignore,
      }),
    }),
  }),

  '/target/ci/image': target({}, {
    render: () => ({
      deps: ['ci:bundlecheck'],
      run: ({ images }) => ({
        FROM: 'node:22-alpine',
        steps: [
          { RUN: 'apk add --no-cache docker-cli docker-cli-buildx' },
          { WORKDIR: '/dagr' },
          { COPY: { from: images['ci:bundlecheck'], src: '/repo/dist/dagr.js', dest: '/dagr/dagr.js' } },
          { ENV: { REPO_ROOT: '/repo' } },
          { ENTRYPOINT: ['node', '--experimental-vm-modules', '/dagr/dagr.js'] },
        ],
        IGNORE: [],
      }),
    }),
  }),
})

export default nodeCli({ versions }).with(dagr)({
  location: import.meta.dagr.location,
  version: '0.0.0',
  deps: [
    { npm: '@caeus/wyr', at: 'prod' },
    { npm: '@optique/core', at: 'prod' },
    { npm: '@optique/run', at: 'prod' },
    { npm: 'smol-toml', at: 'prod' },
    { npm: 'yaml', at: 'prod' },
    { npm: 'zod', at: 'prod' },
  ],
})
