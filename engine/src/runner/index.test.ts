import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { FQT, buildRunner, parseSelector, relativePackageName } from '#runner/index.js'
import type { TargetRunnerDeps } from '#runner/index.js'
import type { BuildResult } from '#runner/docker-builder.js'
import type { HostPlatform, PackageDef, RunContext } from '#pkg/schema.js'
import type { Reporter } from '#report/reporter.js'
import type { LoadedPackage, PackageLoader } from '#pkg/loader.js'

describe('FQT.parse', () => {
  it('parses fully qualified //package:facet:target', () => {
    const fqt = FQT.parse('//a:b:c')
    assert.equal(fqt.pkg, '//a')
    assert.equal(fqt.facet, 'b')
    assert.equal(fqt.target, 'c')
  })

  it('parses the repository root package as //', () => {
    const fqt = FQT.parse('//:ci:deploy')
    assert.equal(fqt.pkg, '//')
    assert.equal(fqt.facet, 'ci')
    assert.equal(fqt.target, 'deploy')
  })

  it('parses facet:target using context package', () => {
    const fqt = FQT.parse('b:c', { pkg: '//mod' })
    assert.equal(fqt.pkg, '//mod')
    assert.equal(fqt.facet, 'b')
    assert.equal(fqt.target, 'c')
  })

  it('throws without package context for facet:target', () => {
    assert.throws(() => FQT.parse('b:c'), /Package required/)
  })

  it('throws without facet context for bare target', () => {
    assert.throws(() => FQT.parse('c', { pkg: '//mod' }), /Facet required/)
  })

  it('requires the repository-root marker on fully qualified targets', () => {
    assert.throws(() => FQT.parse('a:b:c'), /must start with \/\//)
  })

  it('rejects the old hash separator', () => {
    assert.throws(() => FQT.parse('a#b#c'), /Package required/)
    assert.throws(() => FQT.parse('b#c', { pkg: '//mod', facet: 'ci' }), /Invalid FQT/)
  })

  it('resolves ./package against the context package', () => {
    const fqt = FQT.parse('./api:ci:build', { pkg: '//services' })
    assert.equal(fqt.pkg, '//services/api')
    assert.equal(fqt.facet, 'ci')
    assert.equal(fqt.target, 'build')
  })

  it('resolves a nested ./package path', () => {
    assert.equal(FQT.parse('./web/admin:ci:test', { pkg: '//services' }).pkg, '//services/web/admin')
  })

  it('resolves ./package against the repository root', () => {
    assert.equal(FQT.parse('./engine:ci:test', { pkg: '//' }).pkg, '//engine')
  })

  it('resolves a bare . to the context package itself', () => {
    assert.equal(FQT.parse('.:ci:build', { pkg: '//services/api' }).pkg, '//services/api')
    assert.equal(FQT.parse('.:ci:build', { pkg: '//' }).pkg, '//')
  })

  it('resolves ./package inside a mounted context', () => {
    assert.equal(FQT.parse('./c:ci:pack', { pkg: '//tools//b' }).pkg, '//tools//b/c')
  })

  it('throws without package context for a relative package', () => {
    assert.throws(() => FQT.parse('./api:ci:build'), /Package required/)
  })

  it('rejects .. in a relative package', () => {
    assert.throws(() => FQT.parse('./../api:ci:build', { pkg: '//services' }), /Invalid FQT/)
  })

  it('rejects a relative package that crosses a mount boundary', () => {
    assert.throws(() => FQT.parse('./tools//c:ci:pack', { pkg: '//' }), /Invalid FQT/)
  })

  it('toString returns //package:facet:target', () => {
    assert.equal(new FQT('//a', 'b', 'c').toString(), '//a:b:c')
    assert.equal(new FQT('//', 'b', 'c').toString(), '//:b:c')
  })

  it('toJSON equals toString', () => {
    const fqt = new FQT('//a', 'b', 'c')
    assert.equal(fqt.toJSON(), fqt.toString())
  })
})

describe('parseSelector', () => {
  const from = { pkg: '//services' }

  it('reads an anchored package with facet and target', () => {
    assert.deepEqual(
      parseSelector('//engine:ci:test'),
      { pkg: '//engine', facet: 'ci', target: 'test' },
    )
    assert.deepEqual(
      parseSelector('./api:ci:test', from),
      { pkg: '//services/api', facet: 'ci', target: 'test' },
    )
    assert.deepEqual(
      parseSelector('.:ci:test', from),
      { pkg: '//services', facet: 'ci', target: 'test' },
    )
  })

  it('reads an anchored package with a facet as a whole facet', () => {
    assert.deepEqual(parseSelector('//engine:ci'), { pkg: '//engine', facet: 'ci' })
    assert.deepEqual(parseSelector('./api:ci', from), { pkg: '//services/api', facet: 'ci' })
    assert.deepEqual(parseSelector('.:ci', from), { pkg: '//services', facet: 'ci' })
    assert.deepEqual(parseSelector('//:ci'), { pkg: '//', facet: 'ci' })
  })

  it('reads a bare anchored package as the whole package', () => {
    assert.deepEqual(parseSelector('//engine'), { pkg: '//engine' })
    assert.deepEqual(parseSelector('./api', from), { pkg: '//services/api' })
    assert.deepEqual(parseSelector('.', from), { pkg: '//services' })
    assert.deepEqual(parseSelector('//'), { pkg: '//' })
  })

  it('reads an unanchored pair as facet and target of the context package', () => {
    assert.deepEqual(
      parseSelector('ci:test', from),
      { pkg: '//services', facet: 'ci', target: 'test' },
    )
  })

  it('reads a lone unanchored name as a facet of the context package', () => {
    assert.deepEqual(parseSelector('ci', from), { pkg: '//services', facet: 'ci' })
  })

  it('throws without context when the package is omitted', () => {
    assert.throws(() => parseSelector('ci'), /Package required/)
    assert.throws(() => parseSelector('ci:test'), /Package required/)
    assert.throws(() => parseSelector('./api:ci'), /Package required/)
  })

  it('still requires an anchor on a three-segment address', () => {
    assert.throws(() => parseSelector('engine:ci:test', from), /must start with \/\//)
  })

  it('rejects more than three segments', () => {
    assert.throws(() => parseSelector('//engine:ci:test:extra', from), /Invalid FQT/)
  })

  it('rejects .. in a relative package', () => {
    assert.throws(() => parseSelector('./../api:ci', from), /Invalid FQT/)
  })
})

describe('relativePackageName', () => {
  it('names a package under the base package', () => {
    assert.equal(relativePackageName('//services', '//services/api'), './api')
    assert.equal(relativePackageName('//services', '//services/web/admin'), './web/admin')
    assert.equal(relativePackageName('//', '//engine'), './engine')
  })

  it('names the base package itself as a bare dot', () => {
    assert.equal(relativePackageName('//services', '//services'), '.')
    assert.equal(relativePackageName('//', '//'), '.')
  })

  it('returns undefined for a package outside the base', () => {
    assert.equal(relativePackageName('//services', '//engine'), undefined)
    assert.equal(relativePackageName('//engine', '//engineering'), undefined)
  })

  it('names a package under a mounted base', () => {
    assert.equal(relativePackageName('//tools//b', '//tools//b/c'), './c')
  })

  it('round-trips through parseSelector', () => {
    const cases = [
      ['//services', '//services/api'],
      ['//services', '//services/web/admin'],
      ['//services', '//services'],
      ['//', '//engine'],
      ['//', '//'],
      ['//tools//b', '//tools//b/c'],
      ['//tools//b', '//tools//b'],
    ] as const

    for (const [base, pkg] of cases) {
      const name = relativePackageName(base, pkg)
      assert.ok(name !== undefined, `${pkg} should be nameable relative to ${base}`)
      assert.equal(
        parseSelector(`${name}:ci`, { pkg: base }).pkg,
        pkg,
        `${base} + ${name} should resolve back to ${pkg}`,
      )
    }
  })
})

describe('buildRunner', () => {
  const stubBuild = async (_content: string, tag: string): Promise<BuildResult> =>
    ({ tag, digest: `sha256:${tag}` })

  const stubHost: HostPlatform = { os: 'linux', arch: 'arm64', libc: 'musl' }

  const silentReporter = (): Reporter => ({
    targetStarted: () => undefined,
    targetCompleted: () => undefined,
    targetFailed: () => undefined,
    processLine: () => undefined,
    failure: () => undefined,
  })

  const stubDeps: TargetRunnerDeps = {
    renderDockerfile: () => 'FROM scratch\n',
    buildDockerImage: stubBuild,
    reporter: silentReporter(),
  }

  const makePackage = (): Map<string, PackageDef> =>
    new Map([['pkg', {
      ci: {
        a: { deps: [], run: (_d) => ({ FROM: 'alpine', steps: [], IGNORE: [] }) },
        b: { deps: ['a'], run: ({ images }) => ({ FROM: images['a']!, steps: [], IGNORE: [] }) },
      }
    }]])

  const packageLoader = (
    packages: ReadonlyMap<string, PackageDef>,
    contexts: ReadonlyMap<string, string> = new Map(),
    calls?: string[],
  ): PackageLoader => ({
    loadPackage: async (name) => {
      calls?.push(name)
      const definition = packages.get(name)
      return definition
        ? { definition, context: contexts.get(name) ?? `/${name}` }
        : undefined
    },
    loadAllPackages: async () => new Map(
      [...packages].map(([name, definition]) => [
        name,
        { definition, context: contexts.get(name) ?? `/${name}` } satisfies LoadedPackage,
      ]),
    ),
  })

  it('runs a target with no deps', async () => {
    const runner = buildRunner(packageLoader(makePackage()), stubDeps, stubHost)
    const result = await runner(FQT.parse('//pkg:ci:a'))
    assert.equal(result.fqt.toString(), '//pkg:ci:a')
    assert.equal(result.imageTag, 'pkg-ci-a')
  })

  it('uses the loaded physical context for a mounted package', async () => {
    let context = ''
    const mountedPackages = new Map([['pkg//tools', makePackage().get('pkg')!]])
    const runner = buildRunner(packageLoader(
      mountedPackages,
      new Map([['pkg//tools', '/mounts/tools']]),
    ), {
      ...stubDeps,
      buildDockerImage: async (_content, tag, actualContext) => {
        context = actualContext
        return { tag, digest: `sha256:${tag}` }
      },
    }, stubHost)

    await runner(FQT.parse('//pkg//tools:ci:a'))
    assert.equal(context, '/mounts/tools')
  })

  it('memoizes — same promise returned for same fqt', async () => {
    let calls = 0
    const countingDeps: TargetRunnerDeps = {
      ...stubDeps,
      buildDockerImage: async (_c, tag) => { calls++; return { tag, digest: `sha256:${tag}` } },
    }
    const runner = buildRunner(packageLoader(makePackage()), countingDeps, stubHost)
    await Promise.all([runner(FQT.parse('//pkg:ci:a')), runner(FQT.parse('//pkg:ci:a'))])
    assert.equal(calls, 1)
  })

  it('runs deps before the dependent target', async () => {
    const order: string[] = []
    const orderDeps: TargetRunnerDeps = {
      ...stubDeps,
      buildDockerImage: async (_c, tag) => { order.push(tag); return { tag, digest: `sha256:${tag}` } },
    }
    const runner = buildRunner(packageLoader(makePackage()), orderDeps, stubHost)
    await runner(FQT.parse('//pkg:ci:b'))
    assert.equal(order[0], 'pkg-ci-a')
    assert.equal(order[1], 'pkg-ci-b')
  })

  it('loads packages reached by fully qualified dependencies on demand', async () => {
    const calls: string[] = []
    const packages = new Map<string, PackageDef>([
      ['a/b/c', {
        dev: {
          sync: {
            deps: ['//c/d/f:ci:pack'],
            run: ({ images }) => ({
              FROM: images['//c/d/f:ci:pack']!,
              steps: [],
              IGNORE: [],
            }),
          },
        },
      }],
      ['c/d/f', {
        ci: {
          pack: {
            deps: [],
            run: () => ({ FROM: 'alpine', steps: [], IGNORE: [] }),
          },
        },
      }],
    ])
    const runner = buildRunner(packageLoader(packages, new Map(), calls), stubDeps, stubHost)

    await runner(FQT.parse('//a/b/c:dev:sync'))

    assert.deepEqual(calls, ['a/b/c', 'c/d/f'])
  })

  it('passes dependency images and host as one context', async () => {
    let receivedArgs: RunContext[] = []
    const packages = new Map<string, PackageDef>([['pkg', {
      ci: {
        a: { deps: [], run: (_d) => ({ FROM: 'alpine', steps: [], IGNORE: [] }) },
        b: { deps: ['a'], run: (...args: [RunContext]) => { receivedArgs = args; return { FROM: args[0].images['a']!, steps: [], IGNORE: [] } } },
      }
    }]])
    const runner = buildRunner(packageLoader(packages), stubDeps, stubHost)
    await runner(FQT.parse('//pkg:ci:b'))
    assert.deepEqual(receivedArgs, [{ images: { a: 'pkg-ci-a' }, host: stubHost }])
  })

  it('reports every target it builds, including transitive deps', async () => {
    const events: string[] = []
    const runner = buildRunner(packageLoader(makePackage()), {
      ...stubDeps,
      reporter: {
        ...silentReporter(),
        targetStarted: (fqt) => events.push(`start ${fqt}`),
        targetCompleted: (fqt) => events.push(`done ${fqt}`),
      },
    }, stubHost)

    await runner(FQT.parse('//pkg:ci:b'))

    assert.deepEqual(events, [
      'start //pkg:ci:a',
      'done //pkg:ci:a',
      'start //pkg:ci:b',
      'done //pkg:ci:b',
    ])
  })

  it('reports a failed target before propagating the error', async () => {
    const events: string[] = []
    const runner = buildRunner(packageLoader(makePackage()), {
      ...stubDeps,
      buildDockerImage: async () => { throw new Error('docker exploded') },
      reporter: {
        ...silentReporter(),
        targetFailed: (fqt) => events.push(`failed ${fqt}`),
      },
    }, stubHost)

    await assert.rejects(runner(FQT.parse('//pkg:ci:a')), /docker exploded/)
    assert.deepEqual(events, ['failed //pkg:ci:a'])
  })

  it('throws on unknown target', async () => {
    const runner = buildRunner(packageLoader(makePackage()), stubDeps, stubHost)
    await assert.rejects(() => runner(FQT.parse('//pkg:ci:missing')), /Unknown target/)
  })

  it('detects circular dependencies', async () => {
    const circular = new Map<string, PackageDef>([['pkg', {
      ci: {
        a: { deps: ['b'], run: (_d) => ({ FROM: 'alpine', steps: [], IGNORE: [] }) },
        b: { deps: ['a'], run: (_d) => ({ FROM: 'alpine', steps: [], IGNORE: [] }) },
      }
    }]])
    const runner = buildRunner(packageLoader(circular), stubDeps, stubHost)
    await assert.rejects(() => runner(FQT.parse('//pkg:ci:a')), /Circular dependency/)
  })
})
