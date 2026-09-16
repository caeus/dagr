import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FacetDef, IndexDef, MountImplementation, Name, PackageDef, Run, Volumes } from '#pkg/schema.js'

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

describe('PackageDef facets', () => {
  it('applies Name to facet keys', () => {
    assert.equal(PackageDef.safeParse({ 'ci;rm': () => ({ build: target }) }).success, false)
  })

  it('rejects a static record of targets, because a facet is a function', () => {
    assert.equal(PackageDef.safeParse({ ci: { build: target } }).success, false)
  })

  it('accepts a facet without expanding it', () => {
    let expansions = 0
    const parsed = PackageDef.parse({
      ci: () => {
        expansions++
        return { build: target }
      },
    })

    assert.equal(typeof parsed['ci'], 'function')
    assert.equal(expansions, 0, 'parsing a package must not expand its facets')
  })
})

describe('FacetDef expansion', () => {
  it('applies Name to target keys', () => {
    assert.equal(FacetDef.safeParse({ 'build/run': target }).success, false)
  })

  it('preserves additional target fields', () => {
    const definition = { ...target, name: 'build' }
    assert.deepEqual(FacetDef.parse({ build: definition }), { build: definition })
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
