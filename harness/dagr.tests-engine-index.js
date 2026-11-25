import { engine } from '//harness/engine//engine/dagr.engine.js'
import { suite } from '//harness/recipes//tests/dagr.testing.js'

export const graph = engine({ location: '//engine', version: '0.0.0', deps: [] })

export default function engineIndexTests() {
  const { test, results } = suite('engine composition')
  test('exposes one namespaced graph', assert => {
    for (const name of ['typecheck', 'build', 'pack', 'bundle', 'node-base', 'test', 'bundlecheck', 'image', 'publish/pack', 'dev/hoist']) {
      assert.ok(graph['/engine/' + name])
    }
    assert.equal(graph['/engine/package/name'].run({}).value, '@caeus/dagr')
    assert.equal(graph['/engine/typescript/emit-declarations'].run({}).value, false)
    assert.equal(graph['/engine/output/directory'].run({}).value, 'build')
  })
  return { results }
}
