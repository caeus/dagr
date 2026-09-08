import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { loadTypeScript } from './dagr.typescript-loader.js'

const versions = {
  '@tsconfig/strictest': '2',
  'typescript': '6',
  'vitest': '3',
}

describe('mountable TypeScript stack', () => {
  it('loads with dagr import rules and composes executable targets', async () => {
    const stack = await loadTypeScript()
    let calculations
    const project = stack.default({
      base: 'base',
      packageManager: 'pnpm',
      versions,
      conventions: { sourceDirectory: 'source' },
      transform(index, context) {
        calculations = context.calculations
        return index
      },
    })
      .with(stack.library())
      .with(stack.vitest())
    const index = project({ location: '//example', version: '1.0.0' })

    assert.deepEqual(Object.keys(index.config).sort(), ['build', 'dev', 'test', 'typecheck'])
    assert.deepEqual(Object.keys(index.ci).sort(), [
      'build',
      'install-typecheck',
      'install-test',
      'install-build',
      'pack',
      'test',
      'typecheck',
    ].sort())
    assert.deepEqual(Object.keys(index.publish), ['pack'])
    assert.equal(index.ci.test.name, 'test')
    assert.deepEqual([...index.ci.test.deps], ['install-test'])
    assert.equal(typeof index.ci.test.run, 'function')
    assert.equal(calculations.nodes['dev:sync/intent'].deps.length, 0)
    assert.equal(calculations.nodes['dev:sync/intent'].factory(), 'dev')
    assert.equal(calculations.nodes.index.deps[0].tag.description, 'typescript facets')
    const ciTargets = calculations.nodes['facet:ci'].deps[0].tag
    assert.equal(ciTargets.description, 'ci targets')
    assert.ok(calculations.nodes.vitestTestTarget.tags.includes(ciTargets))
    const sourceCopy = index.ci.typecheck.run({ images: { 'install-typecheck': 'image' } }).steps[0]
    assert.equal(sourceCopy.COPY.src, 'source')
    assert.equal(sourceCopy.COPY.dest, '/repo/source')
    assert.deepEqual([...index.publish.pack.deps], ['ci:build'])
    assert.equal(index.publish.pack.run({ images: { 'ci:build': 'build-image' } }).FROM, 'build-image')

    const qualityFacet = stack.facet('quality')
    const health = stack.rdk.graph({
      healthTarget: stack.rdk.derive([], () => stack.target('health', {
        deps: [],
        run: () => ({ FROM: 'scratch', steps: [], IGNORE: [] }),
      }), [qualityFacet.targets]),
    })
    const extended = stack.default({ base: 'base', packageManager: 'pnpm', versions })
      .with(stack.library())
      .with(health)
    assert.equal(extended({ location: '//example' }).quality.health.name, 'health')

    const first = stack.rdk.graph({
      firstTarget: stack.rdk.derive([], () => stack.target('same', {
        deps: [],
        run: () => ({ FROM: 'scratch', steps: [], IGNORE: [] }),
      }), [stack.ciFacet.targets]),
    })
    const second = stack.rdk.graph({
      secondTarget: stack.rdk.derive([], () => stack.target('same', {
        deps: [],
        run: () => ({ FROM: 'scratch', steps: [], IGNORE: [] }),
      }), [stack.ciFacet.targets]),
    })
    const conflicting = stack.default({ base: 'base', packageManager: 'pnpm', versions })
      .with(stack.library())
      .with(first)
      .with(second)
    assert.throws(
      () => conflicting({ location: '//example', version: '1.0.0' }),
      /target "same" has more than one owner/,
    )
  })

  it('uses the selected package manager for install, exec, and pack', async () => {
    const stack = await loadTypeScript()
    const project = stack.default({ base: 'base', packageManager: 'npm', versions })
      .with(stack.library())
    const index = project({
      location: '//packages/example',
      deps: [{ pkg: '//packages/core', at: 'prod' }],
    })

    const install = index.ci['install-typecheck'].run({
      images: {
        'config:typecheck': 'config-image',
        '//packages/core:ci:pack': 'core-pack-image',
      },
    })
    assert.equal(install.steps.at(-1).RUN, 'npm install --include=dev')
    assert.equal(install.steps.some(step => step.RUN?.includes('pnpm')), false)

    const packageStep = install.steps.find(step => step.RUN?.endsWith('> /repo/package.json'))
    const encoded = packageStep.RUN.match(/^echo "([^"]+)"/)[1]
    const packageJson = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
    assert.equal(packageJson.dependencies['@internal/core'], 'file:./core.tgz')

    const typecheck = index.ci.typecheck.run({ images: { 'install-typecheck': 'install-image' } })
    assert.equal(typecheck.steps.at(-1).RUN, 'npm exec -- tsc --noEmit')

    const pack = index.ci.pack.run({
      images: {
        build: 'build-image',
        '//packages/core:ci:pack': 'core-pack-image',
      },
    })
    assert.match(pack.steps.at(-1).RUN, /npm pack --pack-destination \/tmp\/pack/)
  })

  it('uses Yarn 4 package-manager semantics', async () => {
    const stack = await loadTypeScript()
    const yarn = stack.packageManagers.yarn

    assert.equal(yarn.install({ host: { os: 'darwin', arch: 'arm64' } }), 'yarn install --immutable')
    assert.equal(yarn.exec('tsc --noEmit'), 'yarn exec tsc --noEmit')
    assert.equal(yarn.pack('example'), 'mkdir -p /out && yarn pack --out /out/example.tgz')
    assert.deepEqual(yarn.configFiles({ allowBuilds: [] }), [{
      path: '.yarnrc.yml',
      format: 'yaml',
      value: {
        nodeLinker: 'node-modules',
        supportedArchitectures: {
          os: ['current', 'darwin', 'linux', 'win32'],
          cpu: ['current', 'x64', 'arm64'],
          libc: ['current', 'glibc', 'musl'],
        },
        npmRegistryServer: 'https://registry.npmjs.org',
      },
    }])
  })

  it('requires an explicit base target and package manager', async () => {
    const stack = await loadTypeScript()
    assert.throws(() => stack.default({ packageManager: 'npm' }), /requires a base target/)
    assert.throws(
      () => stack.default({ base: 'base' }),
      /Unknown TypeScript package manager undefined/,
    )
    assert.throws(
      () => stack.default({ base: 'base', packageManager: 'bun' }),
      /expected npm, pnpm, or yarn/,
    )
  })
})
