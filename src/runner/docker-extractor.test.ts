import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { copyScript } from './docker-extractor.js'

describe('copyScript', () => {
  it('replaces the destination when neither path has a trailing slash', () => {
    const script = copyScript('/docs', 'docs')
    assert.match(script, /rm -rf "\/host-out\/docs"/)
    assert.match(script, /cp -a "\/docs" "\/host-out\/docs"/)
  })

  it('treats a file the same as a directory', () => {
    const script = copyScript('/repo/package.json', 'package.json')
    assert.match(script, /rm -rf "\/host-out\/package\.json"/)
    assert.match(script, /cp -a "\/repo\/package\.json" "\/host-out\/package\.json"/)
  })

  it('merges contents and never deletes when the source ends in a slash', () => {
    const script = copyScript('/repo/dist/', 'dist/')
    assert.match(script, /cp -a "\/repo\/dist"\/\. "\/host-out\/dist"\//)
    assert.doesNotMatch(script, /rm -rf/)
  })

  it('places the node inside a destination ending in a slash', () => {
    const script = copyScript('/repo/dist', 'build/')
    assert.match(script, /cp -a "\/repo\/dist" "\/host-out\/build\/dist"/)
  })

  it('creates parent directories before copying', () => {
    assert.match(copyScript('/a/b.txt', 'nested/b.txt'), /mkdir -p "\$\(dirname "\/host-out\/nested\/b\.txt"\)"/)
  })

  it('merges into the package directory for ./', () => {
    const script = copyScript('/out/', './')
    assert.match(script, /cp -a "\/out"\/\. "\/host-out"\//)
    assert.doesNotMatch(script, /rm -rf/)
  })

  it('places a node inside the package directory for ./', () => {
    assert.match(copyScript('/repo/dist', './'), /rm -rf "\/host-out\/dist"/)
  })

  it('refuses to replace the package directory itself', () => {
    for (const dest of ['.', '']) {
      assert.throws(() => copyScript('/docs', dest), /cannot replace the package directory itself/)
    }
  })
})
