import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Name, PackageDef } from '#pkg/schema.js'

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
      '#mount',
      'ci#build',
      'ci/build',
      'ci\\build',
      'ci:build',
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
})
