import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createBuiltinModules, matchGlob } from '#pkg/builtins.js'
import { createSandboxContext } from '#pkg/sandbox.js'

describe('dagr:glob', () => {
  it('registers and exposes match like the other built-ins', async () => {
    const module = createBuiltinModules(createSandboxContext()).get('dagr:glob')
    assert.ok(module)

    await module.link(() => { throw new Error('dagr:glob has no imports') })
    await module.evaluate()

    const namespace = module.namespace as unknown as {
      readonly default: { readonly match: typeof matchGlob }
      readonly match: typeof matchGlob
    }
    assert.deepEqual(Object.keys(namespace), ['default', 'match'])
    assert.equal(namespace.default.match, namespace.match)
    assert.equal(namespace.match('file/*', 'file/tsconfig'), true)
  })

  it('matches exact strings', () => {
    assert.equal(matchGlob('file/package-json', 'file/package-json'), true)
    assert.equal(matchGlob('file/package-json', 'file/tsconfig'), false)
  })

  it('matches * as exactly one segment', () => {
    assert.equal(matchGlob('file/*', 'file/tsconfig'), true)
    assert.equal(matchGlob('target/*/build', 'target/ci/build'), true)
    assert.equal(matchGlob('file/*', 'file/foo/bar'), false)
    assert.equal(matchGlob('file/*', 'file/'), false)
  })

  it('matches ** as zero or more segments', () => {
    assert.equal(matchGlob('file/**', 'file/foo/bar'), true)
    assert.equal(matchGlob('**/vitest', 'command/test/vitest'), true)
    assert.equal(matchGlob('target/**/build', 'target/ci/release/build'), true)
  })

  it('allows ** to match an empty descendant path', () => {
    assert.equal(matchGlob('target/**', 'target'), true)
    assert.equal(matchGlob('target/**/build', 'target/build'), true)
  })

  it('keeps wildcard matching within segment boundaries', () => {
    assert.equal(matchGlob('*', 'target'), true)
    assert.equal(matchGlob('*', 'target/ci'), false)
    assert.equal(matchGlob('target/*/build', 'target/ci/test'), false)
    assert.equal(matchGlob('target/**/build', 'target/ci/build/test'), false)
  })

  it('rejects malformed patterns', () => {
    for (const pattern of [
      '',
      '/file',
      'file/',
      'file//tsconfig',
      'file/foo*',
      'file/***',
    ]) {
      assert.throws(
        () => matchGlob(pattern, 'file/tsconfig'),
        /Invalid Dagr glob pattern/,
      )
    }
  })
})
