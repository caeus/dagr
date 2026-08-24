import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { FQT, buildRunner } from './index.js'
import type { TargetRunnerDeps } from './index.js'
import type { BuildResult } from './docker-builder.js'
import type { HostPlatform, PackageDef, RunContext } from '../pkg/schema.js'

describe('FQT.parse', () => {
  it('parses fully qualified package#facet#target', () => {
    const fqt = FQT.parse('a#b#c')
    assert.equal(fqt.pkg, 'a')
    assert.equal(fqt.facet, 'b')
    assert.equal(fqt.target, 'c')
  })

  it('parses facet#target using context package', () => {
    const fqt = FQT.parse('b#c', { pkg: 'mod' })
    assert.equal(fqt.pkg, 'mod')
    assert.equal(fqt.facet, 'b')
    assert.equal(fqt.target, 'c')
  })

  it('throws without package context for facet#target', () => {
    assert.throws(() => FQT.parse('b#c'), /Package required/)
  })

  it('throws without facet context for bare target', () => {
    assert.throws(() => FQT.parse('c', { pkg: 'mod' }), /Facet required/)
  })

  it('toString returns package#facet#target', () => {
    assert.equal(new FQT('a', 'b', 'c').toString(), 'a#b#c')
  })

  it('toJSON equals toString', () => {
    const fqt = new FQT('a', 'b', 'c')
    assert.equal(fqt.toJSON(), fqt.toString())
  })
})

describe('buildRunner', () => {
  const stubBuild = async (_content: string, tag: string): Promise<BuildResult> =>
    ({ tag, digest: `sha256:${tag}` })

  const stubHost: HostPlatform = { os: 'linux', arch: 'arm64', libc: 'musl' }

  const stubDeps: TargetRunnerDeps = {
    renderDockerfile: () => 'FROM scratch\n',
    buildDockerImage: stubBuild,
  }

  const makePackage = (): Map<string, PackageDef> =>
    new Map([['pkg', {
      ci: {
        a: { deps: [], run: (_d) => ({ FROM: 'alpine', steps: [], IGNORE: [] }) },
        b: { deps: ['a'], run: ({ images }) => ({ FROM: images['a']!, steps: [], IGNORE: [] }) },
      }
    }]])

  it('runs a target with no deps', async () => {
    const runner = buildRunner('/', makePackage(), stubDeps, stubHost)
    const result = await runner(FQT.parse('pkg#ci#a'))
    assert.equal(result.fqt.toString(), 'pkg#ci#a')
    assert.equal(result.imageTag, 'pkg-ci-a')
  })

  it('memoizes — same promise returned for same fqt', async () => {
    let calls = 0
    const countingDeps: TargetRunnerDeps = {
      ...stubDeps,
      buildDockerImage: async (_c, tag) => { calls++; return { tag, digest: `sha256:${tag}` } },
    }
    const runner = buildRunner('/', makePackage(), countingDeps, stubHost)
    await Promise.all([runner(FQT.parse('pkg#ci#a')), runner(FQT.parse('pkg#ci#a'))])
    assert.equal(calls, 1)
  })

  it('runs deps before the dependent target', async () => {
    const order: string[] = []
    const orderDeps: TargetRunnerDeps = {
      ...stubDeps,
      buildDockerImage: async (_c, tag) => { order.push(tag); return { tag, digest: `sha256:${tag}` } },
    }
    const runner = buildRunner('/', makePackage(), orderDeps, stubHost)
    await runner(FQT.parse('pkg#ci#b'))
    assert.equal(order[0], 'pkg-ci-a')
    assert.equal(order[1], 'pkg-ci-b')
  })

  it('passes dependency images and host as one context', async () => {
    let receivedArgs: RunContext[] = []
    const packages = new Map<string, PackageDef>([['pkg', {
      ci: {
        a: { deps: [], run: (_d) => ({ FROM: 'alpine', steps: [], IGNORE: [] }) },
        b: { deps: ['a'], run: (...args: [RunContext]) => { receivedArgs = args; return { FROM: args[0].images['a']!, steps: [], IGNORE: [] } } },
      }
    }]])
    const runner = buildRunner('/', packages, stubDeps, stubHost)
    await runner(FQT.parse('pkg#ci#b'))
    assert.deepEqual(receivedArgs, [{ images: { a: 'pkg-ci-a' }, host: stubHost }])
  })

  it('throws on unknown target', async () => {
    const runner = buildRunner('/', makePackage(), stubDeps, stubHost)
    await assert.rejects(() => Promise.resolve().then(() => runner(FQT.parse('pkg#ci#missing'))), /Unknown target/)
  })

  it('detects circular dependencies', async () => {
    const circular = new Map<string, PackageDef>([['pkg', {
      ci: {
        a: { deps: ['b'], run: (_d) => ({ FROM: 'alpine', steps: [], IGNORE: [] }) },
        b: { deps: ['a'], run: (_d) => ({ FROM: 'alpine', steps: [], IGNORE: [] }) },
      }
    }]])
    const runner = buildRunner('/', circular, stubDeps, stubHost)
    await assert.rejects(() => Promise.resolve().then(() => runner(FQT.parse('pkg#ci#a'))), /Circular dependency/)
  })
})
