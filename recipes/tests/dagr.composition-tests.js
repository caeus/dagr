import {
  value, scope, derive, typescript, library, pnpm, npm, vitest, eslint, prettier,
  file, command, tooling, packageJsonDependencies, sourceTarget,
} from '//recipes/tests/typescript//dagr.recipe.js'
import { suite } from '//recipes/tests/dagr.testing.js'

export default function compositionTests() {
  const { test, results } = suite('ordinary graph composition')

  test('features return node records, with namespaced references and no graph object', assert => {
    const graph = {
      ...typescript('app', { base: '//base:/node' }),
      ...library('app'),
      ...pnpm('app'),
      ...vitest('app'),
      ...typescript('lib', { base: '//base:/node' }),
      ...library('lib'),
      ...npm('lib'),
    }
    assert.ok(Object.keys(graph).every(path => path.startsWith('/app/') || path.startsWith('/lib/')))
    assert.ok(Object.values(graph).every(node => typeof node.run === 'function' && node.deps))
    assert.equal(graph['/app/image/base'].deps.image, '//base:/node')
    assert.equal(graph['/app/test'].deps.command, '/app/typescript/tester')
    assert.deepEqual(graph['/app/build'].deps.files, [
      '/app/file/build/package.json',
      '/app/file/build/package-manager/**',
      '/app/file/build/tsconfig.json',
    ])
    assert.equal(graph['/lib/test'], undefined)
  })

  test('ordinary object spread replaces an individual node', assert => {
    const graph = {
      ...typescript('app'),
      ...library('app'),
      '/app/package/name': value('custom'),
    }
    assert.deepEqual(graph['/app/package/name'].run({}), { value: 'custom' })
  })

  test('scope rewrites internal paths and patterns, not local input names or qualified refs', assert => {
    const graph = scope('app', {
      '/result': derive({
        local: '/one',
        external: '//packages/core:/lib/value',
        group: ['/files/**', '/one'],
      }, args => args),
    })
    assert.deepEqual(graph['/app/result'].deps, {
      local: '/app/one',
      external: '//packages/core:/lib/value',
      group: ['/app/files/**', '/app/one'],
    })
    assert.deepEqual(graph['/app/result'].run({ local: 1 }), { value: { local: 1 } })
  })

  test('commands are pure values; generated files are independent nodes', assert => {
    const graph = {
      ...typescript('app'),
      ...library('app'),
      ...eslint('app', { prettier: true }),
      ...prettier('app'),
    }
    assert.deepEqual(graph['/app/eslint/linter'].deps, {})
    assert.deepEqual(graph['/app/eslint/linter'].run({}).value.invocations, [{ tool: 'eslint .' }])
    assert.ok(graph['/app/lint'].deps.files.includes('/app/file/lint/prettierrc.json'))
    assert.ok(graph['/app/lint'].deps.files.includes('/app/file/lint/eslint.config.mjs'))
  })

  test('tooling contributes through ordinary value nodes', assert => {
    const graph = scope('app', {
      '/custom/tooling': tooling({ for: ['lint'], packages: ['custom'] }),
      '/custom/package-json/dependencies': packageJsonDependencies('/custom/tooling'),
    })
    const data = graph['/app/custom/tooling'].run({}).value
    assert.deepEqual(graph['/app/custom/package-json/dependencies'].run({ tooling: data }).value, {
      for: ['lint'], values: ['custom'],
    })
  })

  test('file generation produces a build with a path, without host export', assert => {
    const nodes = file('/repo/config.json', {}, {
      for: ['build'],
      render: () => ({ RUN: 'echo "{}" > /repo/config.json' }),
    })
    const result = nodes['/file/build/config.json'].run({})
    assert.equal(result.build.path, '/repo/config.json')
    assert.equal(result.build.FROM, 'alpine:3.22')
    assert.equal(result.build.EXPORT, undefined)
  })

  test('invalid commands fail at the appropriate boundary', assert => {
    assert.throws(() => command({}, { run: () => ({ tool: 'x' }) }), 'command needs for')
    const invalid = command({}, { for: ['test'], run: () => ({ tool: 'x', shell: 'x' }) })
    assert.throws(() => invalid.run({}), 'exactly one')
    assert.throws(() => sourceTarget({ command: '/x' }), 'intent')
  })

  return { results }
}
