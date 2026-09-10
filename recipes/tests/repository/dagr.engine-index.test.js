import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { loadEngineIndex } from '../dagr.typescript-loader.js'

// This suite needs two packages at once: the recipe, and the engine index that mounts it. It lives
// outside `tests/*.test.js` so //recipes:ci:test keeps running with nothing but recipes/ present.
describe('repository engine index', () => {
  it('composes the engine package with semantic binding paths', async () => {
    const { default: index } = await loadEngineIndex()

    assert.deepEqual(Object.keys(index), ['ci', 'publish'])
    assert.deepEqual(Object.keys(index.ci), [
      'typecheck', 'build', 'pack', 'bundle', 'node-base', 'test', 'bundlecheck', 'image',
    ])
    assert.deepEqual(Object.keys(index.publish), ['pack'])
  })
})
