import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FQT, buildRunner, relativePackageName } from '#runner/index.js'
import { loadedPackage, type PackageLoader } from '#pkg/loader.js'
import type { NodeDef, PackageDef, HostPlatform } from '#pkg/schema.js'
import type { TargetRunnerDeps } from '#runner/target-runner.js'
import { renderDockerfile } from '#runner/dockerfile-renderer.js'

const host: HostPlatform = { os: 'linux', arch: 'arm64', libc: 'musl' }
const reporter = {
  targetStarted() {}, targetCompleted() {}, targetFailed() {},
  processLine() {}, failure() {},
}
const engine: TargetRunnerDeps = {
  renderDockerfile,
  async buildDockerImage(_content, tag) { return { tag, digest: 'sha256:test' } },
  reporter,
}
const value = (value: unknown): NodeDef => ({ deps: {}, run: () => ({ value }) })
const image = (from = 'scratch'): NodeDef => ({
  deps: {}, run: () => ({ build: { FROM: from, steps: [], IGNORE: [] } }),
})
const loader = (graphs: Record<string, PackageDef>, calls: string[] = []): PackageLoader => ({
  async loadPackage(name) {
    calls.push(name)
    const graph = graphs[name]
    return graph && loadedPackage(graph, '/physical/' + name)
  },
  async loadAllPackages() {
    return new Map(Object.entries(graphs).map(([name, graph]) => [
      name, loadedPackage(graph, '/physical/' + name),
    ]))
  },
})

describe('node addresses', () => {
  it('separates project location and semantic path', () => {
    const fqt = FQT.parse('//packages/app:/file/manifest')
    assert.equal(fqt.pkg, '//packages/app')
    assert.equal(fqt.path, '/file/manifest')
    assert.equal(fqt.toJSON(), '//packages/app:/file/manifest')
    assert.equal(FQT.parse('/app/build', { pkg: '//packages' }).toString(), '//packages:/app/build')
    assert.equal(FQT.parse('//:/value').pkg, '//')
    assert.equal(FQT.parse('//tools//:/pack').pkg, '//tools//')
  })

  it('supports relative project addresses in the CLI', () => {
    assert.equal(FQT.parse('./app:/build', { pkg: '//packages' }).toString(), '//packages/app:/build')
    assert.equal(FQT.parse('./app:/build', { pkg: '//' }).toString(), '//app:/build')
    assert.equal(FQT.parse('.:/build', { pkg: '//packages' }).toString(), '//packages:/build')
    assert.throws(() => FQT.parse('./../app:/build', { pkg: '//' }))
    assert.throws(() => FQT.parse('./a//b:/build', { pkg: '//' }))
  })

  it('rejects malformed or old addresses', () => {
    for (const ref of ['//pkg:ci:build', 'ci:build', '/build', '//pkg:/../build', '//pkg:/a/*']) {
      assert.throws(() => FQT.parse(ref))
    }
  })

  it('names only descendant packages', () => {
    assert.equal(relativePackageName('//services', '//services/api'), './api')
    assert.equal(relativePackageName('//services', '//services'), '.')
    assert.equal(relativePackageName('//', '//engine'), './engine')
    assert.equal(relativePackageName('//engine', '//engineering'), undefined)
    assert.equal(relativePackageName('//tools//b', '//tools//b/c'), './c')
  })
})

describe('one graph evaluator', () => {
  it('passes unwrapped named values, including undefined and opaque objects, without building', async () => {
    const opaque = { fn: () => 42 }
    const runner = buildRunner(loader({ app: {
      '/value/a': value(opaque),
      '/value/b': value(undefined),
      '/result': {
        deps: { a: '/value/a', b: '/value/b' },
        run: ({ a, b }, platform) => {
          assert.equal(a, opaque)
          assert.equal(b, undefined)
          assert.deepEqual({ ...platform }, host)
          return { value: 7 }
        },
      },
    } }), {
      ...engine,
      async buildDockerImage() { throw new Error('must not build') },
    }, host)
    assert.equal((await runner(FQT.parse('//app:/result'))).value, 7)
  })

  it('resolves wildcard selections after composition, scoped by namespace', async () => {
    const app = {
      '/app/file/a': value('a'),
      '/app/result': {
        deps: { files: ['/app/file/**', '/app/file/a'], absent: '/app/missing/*' },
        run: ({ files, absent }) => ({ value: { files, absent } }),
      },
    } satisfies PackageDef
    const feature = { '/app/file/b': value('b'), '/lib/file/a': value('outside') }
    const result = await buildRunner(loader({ pkg: { ...app, ...feature } }), engine, host)(
      FQT.parse('//pkg:/app/result'),
    )
    const selected = result.value as { files: Record<string, unknown>; absent: Record<string, unknown> }
    assert.deepEqual({ ...selected.files }, { '/app/file/a': 'a', '/app/file/b': 'b' })
    assert.deepEqual({ ...selected.absent }, {})
  })

  it('loads external exact and wildcard dependencies lazily', async () => {
    const calls: string[] = []
    const runner = buildRunner(loader({
      app: { '/result': {
        deps: { a: '//lib:/a', all: '//lib:/items/*' },
        run: ({ a, all }) => ({ value: [a, { ...(all as object) }] }),
      } },
      lib: { '/a': value(1), '/items/b': value(2) },
      unused: { '/unused': value(3) },
    }, calls), engine, host)
    assert.deepEqual((await runner(FQT.parse('//app:/result'))).value, [
      1, { '//lib:/items/b': 2 },
    ])
    assert.equal(calls.includes('unused'), false)
  })

  it('uses physical context and memoizes shared prerequisites', async () => {
    let builds = 0
    const runner = buildRunner(loader({ 'pkg//tools': {
      '/base': image(),
      '/first': { deps: { base: '/base' }, run: ({ base }) => ({ value: base }) },
      '/second': { deps: { base: '/base' }, run: ({ base }) => ({ value: base }) },
    } }), {
      ...engine,
      async buildDockerImage(_content, tag, context) {
        assert.equal(context, '/physical/pkg//tools')
        builds++
        return { tag, digest: 'sha256:test' }
      },
    }, host)
    const [a, b] = await Promise.all(['/first', '/second'].map(path =>
      runner(new FQT('//pkg//tools', path))))
    assert.equal(a?.value, b?.value)
    assert.equal(builds, 1)
    assert.equal(typeof a?.value, 'string')
  })

  it('passes file references directly into downstream COPY', async () => {
    const dockerfiles: string[] = []
    const runner = buildRunner(loader({ app: {
      '/file': { deps: {}, run: () => ({ build: {
        FROM: 'alpine', steps: [], IGNORE: [], path: '/manifest.json',
      } }) },
      '/image': {
        deps: { manifest: '/file' },
        run: ({ manifest }) => {
          const file = manifest as { image: string; path: string }
          return { build: {
            FROM: 'alpine',
            steps: [{ COPY: { from: file.image, src: file.path, dest: '/manifest.json' } }],
            IGNORE: [],
          } }
        },
      },
    } }), {
      ...engine,
      async buildDockerImage(content, tag) {
        dockerfiles.push(content)
        return { tag, digest: 'sha256:test' }
      },
    }, host)
    await runner(FQT.parse('//app:/image'))
    assert.equal(dockerfiles.length, 2)
    assert.match(dockerfiles[1]!, /COPY --from=dagr-[a-f0-9]+ \/manifest.json \/manifest.json/)
  })

  it('rejects unknown exact dependencies even in a plural selection', async () => {
    const runner = buildRunner(loader({ pkg: {
      '/a': { deps: { files: ['/missing'] }, run: () => ({ value: null }) },
    } }), engine, host)
    await assert.rejects(runner(FQT.parse('//pkg:/a')), /Unknown node/)
  })

  it('detects cycles across concurrent roots', async () => {
    const runner = buildRunner(loader({ pkg: {
      '/a': { deps: { b: '/b' }, run: () => ({ value: 1 }) },
      '/b': { deps: { a: '/a' }, run: () => ({ value: 2 }) },
    } }), engine, host)
    await assert.rejects(Promise.all(['/a', '/b'].map(path =>
      runner(new FQT('//pkg', path)))), /Circular dependency/)
  })

  it('reports failures before propagating them', async () => {
    const events: string[] = []
    const runner = buildRunner(loader({ pkg: { '/image': image() } }), {
      ...engine,
      reporter: { ...reporter, targetFailed: name => events.push(name) },
      async buildDockerImage() { throw new Error('docker failed') },
    }, host)
    await assert.rejects(runner(FQT.parse('//pkg:/image')), /docker failed/)
    assert.deepEqual(events, ['//pkg:/image'])
  })
})
