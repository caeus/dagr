import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { IndexDef, MountImplementation, PackageDef, Result, Run, Volumes } from '#pkg/schema.js'

describe('node graph', () => {
  it('accepts absolute semantic paths and named dependencies', () => {
    const graph = {
      '/config/name': { deps: {}, run: () => ({ value: 'app' }) },
      '/file/manifest': {
        deps: { name: '/config/name', external: '//other:/value' },
        run: (args: unknown) => ({ value: args }),
      },
    }
    assert.equal(PackageDef.safeParse(graph).success, true)
  })

  it('rejects old facets and positional dependencies', () => {
    assert.equal(PackageDef.safeParse({ ci: {} }).success, false)
    assert.equal(PackageDef.safeParse({ '/ci/test': { deps: [], run() {} } }).success, false)
  })

  it('accepts only wrapped values or builds', () => {
    assert.equal(Result.safeParse({ value: undefined }).success, true)
    assert.equal(Result.safeParse({ value: false }).success, true)
    assert.equal(Result.safeParse(false).success, false)
    assert.equal(Result.safeParse({ value: 1, build: {} }).success, false)
    assert.equal(Result.safeParse({ build: { FROM: 'scratch', steps: [], IGNORE: [] } }).success, true)
  })
})

describe('filesystem composition schemas', () => {
  const mount = { FROM: 'alpine', steps: [], IGNORE: [] }

  it('keeps mount implementations out of dagr.index.js', () => {
    assert.equal(IndexDef.safeParse({ '/': mount }).success, false)
  })

  it('uses the existing image recipe schema for volume implementations', () => {
    assert.deepEqual(MountImplementation.parse(mount), mount)
    assert.deepEqual(Volumes.parse({ tools: mount }), { tools: mount })
  })
})

describe('Run EXPORT destinations', () => {
  it('rejects absolute paths and parent escapes', () => {
    for (const dest of ['/tmp/out', '../out', 'nested/../../out']) {
      const run = {
        FROM: 'scratch',
        steps: [],
        IGNORE: [],
        EXPORT: { '/out': dest },
      }
      assert.equal(Run.safeParse(run).success, false)
    }
  })
})
