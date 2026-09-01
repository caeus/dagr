import bundledVersions from '//dagr.versions.yaml'
import di from '//di//dagr.di.js'
import { pnpmfile } from '//dagr.utils.js'
import {
  TYPESCRIPT_LIBRARY_DAG,
  typescriptLibraryProjector,
} from '//dagr.projections.js'
import { writeJson, writeText } from '//dagr.file_utils.js'
import { RECOMMENDED_IGNORE } from '//dagr.dockerignore.js'

function writeProjectedFile(path, value) {
  return typeof value === 'string'
    ? writeText(`/repo/${path}`, value)
    : writeJson(`/repo/${path}`, value)
}

export default function typescript({
  base = '//packages/base:ci:node-pnpm',
  scope = 'internal',
  versions = bundledVersions.deps,
  ignore = RECOMMENDED_IGNORE,
  testEnvironment = 'node',
  transform = index => index,
} = {}) {
  return function stack({
    location,
    version = '0.1.0',
    deps = [],
    metadata = {},
  }) {
    const localDeps = deps.filter(dependency => 'pkg' in dependency)
    const packTarget = dependency => `${dependency.pkg}:ci:pack`
    const packTargets = localDeps.map(packTarget)
    const project = typescriptLibraryProjector(di, {
      location,
      scope,
      version,
      deps,
      metadata,
      versions,
      testEnvironment,
    })
    const { name, slug } = project('dev:sync')

    const configuration = target => {
      const projection = project(target)
      return {
        deps: [base],
        run: ({ images: images }) => ({
          FROM: images[base],
          steps: [
            { WORKDIR: '/repo' },
            ...Object.entries(projection.files).map(([path, value]) => writeProjectedFile(path, value)),
          ],
          IGNORE: ignore,
        }),
      }
    }

    const install = action => ({
      deps: [`config:${action}`, ...packTargets],
      run: ({ images: images }) => ({
        FROM: images[`config:${action}`],
        steps: [
          ...localDeps.map(dependency => ({
            COPY: { from: images[packTarget(dependency)], src: '/out', dest: '/repo' },
          })),
          { WORKDIR: '/repo' },
          writeText('/repo/.pnpmfile.cjs', pnpmfile(scope)),
          { RUN: 'pnpm install --prod=false' },
        ],
        IGNORE: ignore,
      }),
    })

    const pack = target => ({
      deps: ['ci:build', ...packTargets],
      run: ({ images: images }) => ({
        FROM: images['ci:build'],
        steps: [
          ...localDeps.map(dependency => ({
            COPY: { from: images[packTarget(dependency)], src: '/out', dest: '/out' },
          })),
          { WORKDIR: '/repo' },
          // The distribution manifest replaces the build manifest immediately before packing.
          // `pack` remains private for local dependency artifacts; `publish` is publishable.
          writeJson('/repo/package.json', project(target).packageJson),
          { RUN: `mkdir -p /tmp/pack /out && pnpm pack --pack-destination /tmp/pack && mv /tmp/pack/*.tgz /out/${slug}.tgz` },
        ],
        IGNORE: ignore,
      }),
    })

    const dev = project('dev:sync')
    const index = {
      config: {
        dev: configuration('config:dev'),
        typecheck: configuration('config:typecheck'),
        test: configuration('config:test'),
        build: configuration('config:build'),
      },
      dev: {
        sync: {
          deps: ['config:dev'],
          run: ({ images: images }) => ({
            FROM: images['config:dev'],
            steps: [],
            IGNORE: ignore,
            EXPORT: Object.fromEntries(Object.keys(dev.files).map(path => [`/repo/${path}`, path])),
          }),
        },
      },
      ci: {
        'install-typecheck': install('typecheck'),
        'install-test': install('test'),
        'install-build': install('build'),
        typecheck: {
          deps: ['install-typecheck'],
          run: ({ images: images }) => ({
            FROM: images['install-typecheck'],
            steps: [
              { COPY: { src: 'src', dest: '/repo/src' } },
              { WORKDIR: '/repo' },
              { RUN: 'pnpm exec tsc' },
            ],
            IGNORE: ignore,
          }),
        },
        test: {
          deps: ['install-test'],
          run: ({ images: images }) => ({
            FROM: images['install-test'],
            steps: [
              { COPY: { src: 'src', dest: '/repo/src' } },
              { WORKDIR: '/repo' },
              { RUN: 'pnpm exec vitest run' },
            ],
            IGNORE: ignore,
          }),
        },
        build: {
          deps: ['install-build'],
          run: ({ images: images }) => ({
            FROM: images['install-build'],
            steps: [
              { COPY: { src: 'src', dest: '/repo/src' } },
              { WORKDIR: '/repo' },
              { RUN: 'pnpm exec tsc' },
            ],
            IGNORE: ignore,
          }),
        },
        pack: pack('ci:pack'),
      },
      publish: {
        // This target creates a publishable artifact. The registry/location adapter performs the
        // actual publish and owns visibility, authentication, provenance, and tags.
        pack: pack('publish:pack'),
      },
    }

    return transform(index, {
      location,
      name,
      slug,
      project,
      calculations: TYPESCRIPT_LIBRARY_DAG,
    })
  }
}
