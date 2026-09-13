import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { of as globOf } from '#pkg/glob.js'
import { SemanticPathIndex } from '#pkg/rdk-index.js'

const matcher = (selector: string, path: string): boolean => (
  globOf(selector.slice(1))(path.slice(1))
)

describe('RDK semantic path index', () => {
  it('uses literal segments to narrow leading-** selectors', () => {
    const index = new SemanticPathIndex([
      '/typescript/package-json',
      '/typescript/package-json/hoisted',
      '/typescript/tsconfig/hoisted',
      ...Array.from({ length: 100 }, (_, i) => `/unrelated/${i}`),
    ])
    let tested = 0

    assert.deepEqual(index.matching(['/**/hoisted'], (selector, path) => {
      tested++
      return matcher(selector, path)
    }), [
      '/typescript/package-json/hoisted',
      '/typescript/tsconfig/hoisted',
    ])
    assert.equal(tested, 2)
  })

  it('preserves graph order across selector unions and removes overlaps', () => {
    const index = new SemanticPathIndex([
      '/feature/first/hoisted',
      '/target/ci/build',
      '/feature/second/hoisted/file',
      '/target/ci/test',
    ])

    assert.deepEqual(index.matching([
      '/target/ci/*',
      '/**/hoisted',
      '/**/hoisted/*',
      '/target/ci/build',
    ], matcher), [
      '/feature/first/hoisted',
      '/target/ci/build',
      '/feature/second/hoisted/file',
      '/target/ci/test',
    ])
  })

  it('falls back to all graph keys when a selector has no literal segment', () => {
    const keys = ['/a', '/b/c', '/d/e/f']
    const index = new SemanticPathIndex(keys)
    let tested = 0

    assert.deepEqual(index.matching(['/**'], (selector, path) => {
      tested++
      return matcher(selector, path)
    }), keys)
    assert.equal(tested, keys.length)
  })
})
