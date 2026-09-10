import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { loadTypeScript } from './dagr.typescript-loader.js'

const versions = {
  '@tailwindcss/vite': '4',
  '@tsconfig/strictest': '2',
  '@types/node': '22',
  '@vitejs/plugin-react': '4',
  'class-variance-authority': '0.7',
  clsx: '2',
  react: '19',
  'react-dom': '19',
  'react-router-dom': '7',
  'tailwind-merge': '3',
  tailwindcss: '4',
  typescript: '6',
  vite: '5',
  vitest: '3',
}

const decodeWritten = (steps, path) => {
  const step = steps.find(candidate => candidate.RUN?.endsWith(`> /repo/${path}`))
  assert.ok(step, `${path} was not written`)
  return JSON.parse(Buffer.from(step.RUN.match(/^echo "([^"]+)"/)[1], 'base64').toString('utf8'))
}

const runTarget = (target, extra = {}) => target.run({
  images: Object.fromEntries(target.deps.map(dependency => [dependency, `${dependency}-image`])),
  ...extra,
})

describe('mountable TypeScript recipe', () => {
  it('loads with Dagr imports and exposes only contributed facets and targets', async () => {
    const ts = await loadTypeScript()
    const index = ts.default([
      ts.typescript({ base: '//base:ci:image', versions, sourceDirectory: 'source' }),
      ts.pnpm(),
      ts.library(),
      ts.vitest(),
    ])({ location: '//example', version: '1.0.0' })

    assert.deepEqual(Object.keys(index), ['ci', 'publish'])
    assert.deepEqual(Object.keys(index.ci), ['typecheck', 'build', 'pack', 'test'])
    assert.deepEqual(Object.keys(index.publish), ['pack'])
    assert.deepEqual(index.ci.typecheck.deps, ['//base:ci:image'])
    assert.deepEqual(runTarget(index.ci.typecheck).steps[0], {
      COPY: { src: 'source', dest: '/repo/source' },
    })
    assert.deepEqual(index.publish.pack.deps, ['ci:build'])
  })

  it('installs local packages from tarballs but packs a public manifest', async () => {
    const ts = await loadTypeScript()
    const index = ts.default([
      ts.typescript({ base: '//base:ci:image', versions }),
      ts.pnpm(),
      ts.library(),
    ])({
      location: '//packages/example',
      version: '1.0.0',
      deps: [{ pkg: '//packages/core', at: 'prod' }],
    })

    const build = runTarget(index.ci.build)
    assert.equal(
      decodeWritten(build.steps, 'package.json').dependencies['@internal/core'],
      'file:./core.tgz',
    )
    assert.deepEqual(build.steps[0], {
      COPY: { from: '//packages/core:ci:pack-image', src: '/out', dest: '/repo' },
    })

    const packed = runTarget(index.ci.pack)
    assert.equal(
      decodeWritten(packed.steps, 'package.json').dependencies['@internal/core'],
      '>=0.0.0',
    )
    assert.equal(packed.FROM, 'build-image')
  })

  it('expresses npm, pnpm, and yarn as ordinary nodes plus contributions', async () => {
    const ts = await loadTypeScript()
    const indexFor = manager => ts.default([
      ts.typescript({ base: '//base:ci:image', versions }),
      manager,
      ts.library(),
      ts.vitest(),
    ])({ location: '//packages/example' })

    const npm = runTarget(indexFor(ts.npm()).ci.test)
    assert.equal(npm.steps.at(-2).RUN, 'npm install --include=dev')
    assert.equal(npm.steps.at(-1).RUN, 'npm exec -- vitest run')

    const pnpm = runTarget(indexFor(ts.pnpm()).ci.test)
    assert.equal(pnpm.steps.at(-2).RUN, 'pnpm install --prod=false')
    assert.deepEqual(decodeWritten(pnpm.steps, 'pnpm-workspace.yaml'), {
      allowBuilds: { esbuild: true },
    })

    const yarn = runTarget(indexFor(ts.yarn()).ci.test)
    assert.equal(yarn.steps.at(-2).RUN, 'yarn install --no-immutable')
    assert.deepEqual(decodeWritten(yarn.steps, '.yarnrc.yml'), { nodeLinker: 'node-modules' })
    assert.deepEqual(decodeWritten(yarn.steps, 'package.json').dependenciesMeta, {
      esbuild: { built: true },
    })

    const replaced = ts.default([
      ts.typescript({ base: '//base:ci:image', versions }),
      ts.pnpm(),
      ts.npm(),
      ts.library(),
      ts.vitest(),
    ])({ location: '//packages/example' })
    const npmAfterPnpm = runTarget(replaced.ci.test)
    assert.equal(npmAfterPnpm.steps.some(step => step.RUN?.endsWith('pnpm-workspace.yaml')), false)
    assert.equal(npmAfterPnpm.steps.at(-2).RUN, 'npm install --include=dev')
  })

  it('passes host context only where a target chooses to render with it', async () => {
    const ts = await loadTypeScript()
    const index = ts.default([
      ts.typescript({ base: '//base:ci:image', versions }),
      ts.yarn(),
      ts.viteReact(),
      ts.hostDev(),
    ])({ location: '//packages/web' })

    const sync = runTarget(index.dev.sync, { host: { os: 'linux', arch: 'arm64' } })
    assert.deepEqual(decodeWritten(sync.steps, '.yarnrc.yml'), {
      nodeLinker: 'node-modules',
      supportedArchitectures: { os: ['linux'], cpu: ['arm64'] },
    })
    // Nothing but generated files reaches /repo, so exporting all of it is precise.
    assert.deepEqual(sync.EXPORT, { '/repo/': './' })
    assert.equal(sync.steps.some(step => step.COPY?.src === 'src'), false)
    assert.equal(sync.steps.some(step => step.RUN?.includes('install')), false)

    const build = runTarget(index.ci.build, { host: { os: 'linux', arch: 'arm64' } })
    assert.deepEqual(decodeWritten(build.steps, '.yarnrc.yml'), { nodeLinker: 'node-modules' })
  })

  it('supports a custom manager as a normal feature graph', async () => {
    const ts = await loadTypeScript()
    const bun = ts.rdk.graph({
      '/package-manager/install-manifest': ts.rdk.value(ts.fileTarballs),
      '/package-manager/exec': ts.rdk.value(invocation => `bun x ${invocation}`),
      '/package-manager/script': ts.rdk.value(invocation => invocation),
      '/package-manager/install': ts.rdk.value(() => 'bun install'),
      '/package-manager/pack': ts.rdk.value(slug => `bun pm pack --destination /out --filename ${slug}.tgz`),
      '/command/pack/package': ts.command(['/package-manager/pack', '/package/slug'], {
        for: ['pack', 'publish'],
        run: (pack, slug) => ({ shell: pack(slug) }),
      }),
      '/file/package-manager': ts.file([], {
        for: ['dev', 'typecheck', 'test', 'lint', 'docs', 'build'],
        render: () => ({ RUN: 'write bunfig.toml' }),
      }),
    })
    const index = ts.default([
      ts.typescript({ base: '//base:ci:image', versions }),
      bun,
      ts.library(),
    ])({ location: '//packages/example' })

    const typecheck = runTarget(index.ci.typecheck)
    assert.ok(typecheck.steps.some(step => step.RUN === 'write bunfig.toml'))
    assert.equal(typecheck.steps.at(-2).RUN, 'bun install')
    assert.equal(typecheck.steps.at(-1).RUN, 'bun x tsc --noEmit')
    assert.equal(runTarget(index.ci.pack).steps.at(-1).RUN, 'bun pm pack --destination /out --filename example.tgz')
  })

  it('keeps the declaration irreducible and right-biased', async () => {
    const ts = await loadTypeScript()
    const index = ts.default([
      ts.typescript({ base: '//base:ci:image', versions }),
      ts.npm(),
      ts.library(),
      ts.rdk.graph({ '/package/location': ts.rdk.value('//wrong') }),
    ])({ location: '//packages/example', metadata: { description: 'Example' } })

    const manifest = decodeWritten(runTarget(index.ci.typecheck).steps, 'package.json')
    assert.equal(manifest.name, '@internal/example')
    assert.equal(manifest.description, 'Example')
  })

  it('requires only facts and execution contributions reached by targets', async () => {
    const ts = await loadTypeScript()
    assert.throws(() => ts.typescript({}), /requires a base target/)
    // A library needs a package manager to resolve its tools and install them.
    assert.throws(
      () => ts.default([ts.typescript({ base: '//base:ci:image', versions }), ts.library()])({ location: '//x' }),
      /Missing binding "\/package-manager\/exec" required by "\/target\/ci\/typecheck"/,
    )
    assert.throws(
      () => ts.default([
        ts.typescript({ base: '//base:ci:image', versions }),
        ts.rdk.graph({
          '/package-manager/exec': ts.rdk.value(String),
          '/package-manager/install': ts.rdk.value(String),
          '/package-manager/script': ts.rdk.value(String),
        }),
        ts.library(),
      ])({ location: '//x' }),
      /Missing binding "\/package-manager\/install-manifest" required by "\/file\/package-json"/,
    )
    assert.deepEqual(
      ts.default([ts.typescript({ base: '//base:ci:image', versions }), ts.npm()])({ location: '//x' }),
      {},
    )
    assert.throws(
      () => ts.default([ts.typescript({ base: '//base:ci:image', versions }), ts.npm(), ts.library()])({}),
      /requires a location/,
    )
    assert.throws(() => ts.default([{ location: '//x' }]), /Can only merge another graph/)
  })
})
