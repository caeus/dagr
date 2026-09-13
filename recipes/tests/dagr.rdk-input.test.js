import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { loadTypeScript } from './dagr.typescript-loader.js'

const { rdk } = await loadTypeScript()

describe('recipe RDK input()', () => {
  it('combines required exact keys with optional plural patterns', () => {
    const result = rdk.graph({
      '/compiler': rdk.value('tsc'),
      '/config': rdk.value('tsconfig.json'),
      '/vitest/types': rdk.value('vitest/globals'),
      '/node/types': rdk.value('node'),
      '/selection': rdk.derive({
        compiler: rdk.input({
          keys: ['/compiler', '/config'],
          patterns: ['/**/types'],
        }, ({ keys, patterns }) => Object.freeze({
          command: keys['/compiler'],
          config: keys['/config'],
          types: Object.values(patterns),
        })),
      }, ({ compiler }) => compiler),
    }).compile(['/selection'])['/selection']

    assert.deepEqual(result, {
      command: 'tsc',
      config: 'tsconfig.json',
      types: ['vitest/globals', 'node'],
    })
  })
})
