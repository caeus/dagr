import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { IndexDef, Name, PackageDef, Run } from '#pkg/schema.js'

const target = { deps: [], run: () => ({ FROM: 'scratch', steps: [], IGNORE: [] }) }

describe('Name', () => {
  it('accepts portable shell-safe names', () => {
    for (const name of ['ci', 'CI', 'node24', 'node-pnpm', 'type_check', 'release.v2']) {
      assert.equal(Name.parse(name), name)
    }
  })

  it('rejects separators, shell syntax, whitespace, and unsafe leading characters', () => {
    for (const name of [
      '',
      '/',
      'ci:build',
      'ci/build',
      'ci\\build',
      'ci;build',
      'ci build',
      'ci\nbuild',
      '$ci',
      '*',
      '.hidden',
      '-flag',
      '_private',
    ]) {
      assert.equal(Name.safeParse(name).success, false, name)
    }
  })
})

describe('PackageDef names', () => {
  it('applies Name to facet keys', () => {
    assert.equal(PackageDef.safeParse({ 'ci;rm': { build: target } }).success, false)
  })

  it('applies Name to target keys', () => {
    assert.equal(PackageDef.safeParse({ ci: { 'build/run': target } }).success, false)
  })

  it('rejects "/" as a reserved facet name', () => {
    const result = PackageDef.safeParse({ '/': { build: target } })
    assert.equal(result.success, false)
    if (!result.success)
      assert.match(result.error.message, /reserved for mount declarations/)
  })

  it('preserves additional target fields', () => {
    const definition = { ...target, name: 'build' }
    assert.deepEqual(
      PackageDef.parse({ ci: { build: definition } }),
      { ci: { build: definition } },
    )
  })
})

describe('IndexDef', () => {
  const id = 'github.com/acme/foo'

  it('accepts a mount as an alternative to a package', () => {
    assert.deepEqual(IndexDef.parse({ '/': id }), { '/': id })
  })

  it('rejects facets alongside a mount', () => {
    assert.equal(IndexDef.safeParse({ '/': id, ci: { build: target } }).success, false)
  })

  it('rejects non-string and empty mount IDs', () => {
    for (const value of [undefined, null, 1, {}, [], ''])
      assert.equal(IndexDef.safeParse({ '/': value }).success, false)
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
