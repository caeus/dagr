import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createBuiltinModules } from '#pkg/builtins.js'
import { createSandboxContext } from '#pkg/sandbox.js'

async function globModule() {
  const module = createBuiltinModules(createSandboxContext()).get('dagr:glob')
  assert.ok(module)

  await module.link(() => { throw new Error('dagr:glob has no imports') })
  await module.evaluate()

  return module.namespace as unknown as {
    readonly default: {
      readonly of: (pattern: string) => (path: string) => boolean
    }
    readonly of: (pattern: string) => (path: string) => boolean
  }
}

describe('dagr:glob', () => {
  it('registers and exposes of like the other built-ins', async () => {
    const namespace = await globModule()
    assert.deepEqual(Object.keys(namespace), ['default', 'of'])
    assert.equal(namespace.default.of, namespace.of)
  })

  it('compiles a pattern once into a reusable predicate', async () => {
    const { of } = await globModule()
    const matches = of('file/*')

    assert.equal(matches('file/tsconfig'), true)
    assert.equal(matches('file/package-json'), true)
    assert.equal(matches('file/foo/bar'), false)
  })

  it('returns a frozen predicate', async () => {
    const { of } = await globModule()
    assert.equal(Object.isFrozen(of('file/*')), true)
  })

  it('matches exact strings', async () => {
    const { of } = await globModule()
    const matches = of('file/package-json')
    assert.equal(matches('file/package-json'), true)
    assert.equal(matches('file/tsconfig'), false)
  })

  it('matches * as exactly one segment', async () => {
    const { of } = await globModule()
    assert.equal(of('file/*')('file/tsconfig'), true)
    assert.equal(of('target/*/build')('target/ci/build'), true)
    assert.equal(of('file/*')('file/foo/bar'), false)
    assert.equal(of('file/*')('file/'), false)
  })

  it('matches ** as zero or more segments', async () => {
    const { of } = await globModule()
    assert.equal(of('file/**')('file/foo/bar'), true)
    assert.equal(of('**/vitest')('command/test/vitest'), true)
    assert.equal(of('target/**/build')('target/ci/release/build'), true)
  })

  it('allows ** to match an empty descendant path', async () => {
    const { of } = await globModule()
    assert.equal(of('target/**')('target'), true)
    assert.equal(of('target/**/build')('target/build'), true)
  })

  it('keeps wildcard matching within segment boundaries', async () => {
    const { of } = await globModule()
    assert.equal(of('*')('target'), true)
    assert.equal(of('*')('target/ci'), false)
    assert.equal(of('target/*/build')('target/ci/test'), false)
    assert.equal(of('target/**/build')('target/ci/build/test'), false)
  })

  it('rejects malformed patterns while compiling', async () => {
    const { of } = await globModule()
    for (const pattern of [
      '',
      '/file',
      'file/',
      'file//tsconfig',
      'file/foo*',
      'file/***',
    ]) {
      assert.throws(
        () => of(pattern),
        /Invalid Dagr glob pattern/,
      )
    }
  })
})
