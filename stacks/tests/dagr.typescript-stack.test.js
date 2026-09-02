import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { loadTypeScript } from './dagr.typescript-loader.js'

describe('mountable TypeScript stack', () => {
  it('loads with dagr import rules and composes executable targets', async () => {
    const stack = await loadTypeScript()
    const versions = {
      '@tsconfig/strictest': '2',
      'typescript': '6',
      'vitest': '3',
    }
    let calculations
    const project = stack.default({
      base: 'base',
      versions,
      conventions: { sourceDirectory: 'source' },
      transform(index, context) {
        calculations = context.calculations
        return index
      },
    })
      .with(stack.library())
      .with(stack.vitest())
    const index = project({ location: '//example', version: '1.0.0' })

    assert.deepEqual(Object.keys(index.config).sort(), ['build', 'dev', 'test', 'typecheck'])
    assert.deepEqual(Object.keys(index.ci).sort(), [
      'build',
      'install-typecheck',
      'install-test',
      'install-build',
      'pack',
      'test',
      'typecheck',
    ].sort())
    assert.deepEqual(Object.keys(index.publish), ['pack'])
    assert.equal(index.ci.test.name, 'test')
    assert.deepEqual([...index.ci.test.deps], ['install-test'])
    assert.equal(typeof index.ci.test.run, 'function')
    assert.equal(calculations.nodes['dev:sync/intent'].deps.length, 0)
    assert.equal(calculations.nodes['dev:sync/intent'].factory(), 'dev')
    assert.equal(calculations.nodes.index.deps[0].tag.description, 'typescript facets')
    const ciTargets = calculations.nodes['facet:ci'].deps[0].tag
    assert.equal(ciTargets.description, 'ci targets')
    assert.ok(calculations.nodes.vitestTestTarget.tags.includes(ciTargets))
    const sourceCopy = index.ci.typecheck.run({ images: { 'install-typecheck': 'image' } }).steps[0]
    assert.equal(sourceCopy.COPY.src, 'source')
    assert.equal(sourceCopy.COPY.dest, '/repo/source')
    assert.deepEqual([...index.publish.pack.deps], ['ci:build'])
    assert.equal(index.publish.pack.run({ images: { 'ci:build': 'build-image' } }).FROM, 'build-image')

    const qualityFacet = stack.facet('quality')
    const health = stack.di.module({
      healthTarget: stack.di.toFun([], () => stack.target('health', {
        deps: [],
        run: () => ({ FROM: 'scratch', steps: [], IGNORE: [] }),
      }), [qualityFacet.targets]),
    })
    const extended = stack.default({ base: 'base', versions })
      .with(stack.library())
      .with(health)
    assert.equal(extended({ location: '//example' }).quality.health.name, 'health')

    const first = stack.di.module({
      firstTarget: stack.di.toFun([], () => stack.target('same', {
        deps: [],
        run: () => ({ FROM: 'scratch', steps: [], IGNORE: [] }),
      }), [stack.ciFacet.targets]),
    })
    const second = stack.di.module({
      secondTarget: stack.di.toFun([], () => stack.target('same', {
        deps: [],
        run: () => ({ FROM: 'scratch', steps: [], IGNORE: [] }),
      }), [stack.ciFacet.targets]),
    })
    const conflicting = stack.default({ base: 'base', versions })
      .with(stack.library())
      .with(first)
      .with(second)
    assert.throws(
      () => conflicting({ location: '//example', version: '1.0.0' }),
      /target "same" has more than one owner/,
    )
  })
})
