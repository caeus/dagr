import { engine } from '//harness/engine//engine/dagr.engine.js'
import { suite } from '//harness/recipes//tests/dagr.testing.js'

/**
 * The engine composes the recipe it mounts from this workspace, so its composition is the one place a
 * recipe change is proven against a real consumer. The declaration is supplied here rather than read
 * from `import.meta.dagr`, which only a package's own index has.
 */
export default function engineIndexTests() {
  const { test, results } = suite('engine composition')

  const index = engine({ location: '//engine', version: '0.0.0', deps: [] })

  test('exposes the facets and targets the engine composes', assert => {
    assert.deepEqual(Object.keys(index), ['ci', 'publish', 'dev'])
    assert.deepEqual(Object.keys(index.ci()), [
      'typecheck', 'build', 'pack', 'bundle', 'node-base', 'test', 'bundlecheck', 'image',
    ])
    assert.deepEqual(Object.keys(index.publish()), ['pack'])
    assert.deepEqual(Object.keys(index.dev()), ['hoist'])
  })

  const written = (steps, path) => {
    const step = steps.find(candidate => candidate.RUN?.endsWith(`> /repo/${path}`))
    if (step === undefined) throw new Error(`${path} was not written`)
    return JSON.parse(Buffer.from(step.RUN.match(/^echo "([^"]+)"/)[1], 'base64').toString('utf8'))
  }

  test('overrides the derived package name and emits no declarations', assert => {
    const build = index.ci().build.run({ images: { '//engine:ci:node-base': 'base' } })
    const manifest = written(build.steps, 'package.json')
    const tsconfig = written(build.steps, 'tsconfig.json')

    assert.equal(manifest.name, '@caeus/dagr', 'name comes from the engine binding')
    assert.equal(manifest.imports['#*'], './build/*', 'subpath imports point at the output')
    assert.equal(tsconfig.compilerOptions.declaration, false, 'a bundled CLI emits no declarations')
    assert.equal(tsconfig.compilerOptions.outDir, 'build')
  })

  return { results }
}
