import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { parse as parseToml } from 'smol-toml'
import { parse as parseYaml } from 'yaml'
import { RepositoryPackageLoader, type MountMaterializer } from '#pkg/loader.js'

async function fixture(
  marker: string,
  files: Readonly<Record<string, string>> = {}
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dagr-loader-'))
  await mkdir(join(root, 'packages'))
  await mkdir(join(root, '.dagr'))
  await writeFile(join(root, '.dagr/config.js'), `
    export const mount = id => ({ FROM: id, steps: [], IGNORE: [] })
  `)
  await writeFile(join(root, 'dagr.index.js'), marker)
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, contents)
  }
  return root
}

describe('RepositoryPackageLoader', () => {
  it('lets the VM linker resolve shared transitive imports once', async () => {
    const root = await fixture(`
      import { left } from '//lib/dagr.left.js'
      import { right } from '//lib/dagr.right.js'

      export default {
        ci: {
          inspect: {
            deps: [],
            run: () => ({ FROM: left + right, steps: [], IGNORE: [] })
          }
        }
      }
    `, {
      'lib/dagr.left.js': `
        import { shared } from '//lib/dagr.shared.js'
        export const left = shared
      `,
      'lib/dagr.right.js': `
        import { shared } from '//lib/dagr.shared.js'
        export const right = shared
      `,
      'lib/dagr.shared.js': `export const shared = 'a'`,
    })

    try {
      const loaded = await new RepositoryPackageLoader(root).loadPackage('.')
      assert.equal(loaded?.definition['ci']?.['inspect']?.run({
        images: {},
        host: { os: 'linux', arch: 'x64' },
      }).FROM, 'aa')
    } finally {
      await rm(root, { recursive: true })
    }
  })

  it('discovers packages recursively without privileging a directory name', async () => {
    const declaration = `
      export default {
        ci: {
          build: {
            deps: [],
            run: () => ({ FROM: 'alpine', steps: [], IGNORE: [] })
          }
        }
      }
    `
    const root = await fixture(declaration, {
      'engine/dagr.index.js': declaration,
      'stacks/dagr.index.js': declaration,
      'apps/web/dagr.index.js': declaration,
    })

    try {
      const packages = await new RepositoryPackageLoader(root).loadAllPackages()
      assert.deepEqual([...packages.keys()].sort(), ['.', 'apps/web', 'engine', 'stacks'])
    } finally {
      await rm(root, { recursive: true })
    }
  })

  it('continues discovery below packages and ignores repository metadata', async () => {
    const declaration = `
      export default {
        ci: {
          build: {
            deps: [],
            run: () => ({ FROM: 'alpine', steps: [], IGNORE: [] })
          }
        }
      }
    `
    const root = await fixture('', {
      'apps/dagr.index.js': declaration,
      'apps/nested/dagr.index.js': declaration,
      'node_modules/dependency/dagr.index.js': declaration,
      '.git/objects/dagr.index.js': declaration,
    })

    try {
      const packages = await new RepositoryPackageLoader(root).loadAllPackages()
      assert.deepEqual([...packages.keys()].sort(), [
        'apps',
        'apps/nested',
        'node_modules/dependency',
      ])
    } finally {
      await rm(root, { recursive: true })
    }
  })

  it('exposes the canonical package location through import.meta.dagr', async () => {
    const declaration = `
      const metadata = {
        location: import.meta.dagr.location,
        immutable: (() => {
          try { import.meta.dagr.location = 'changed'; return 'false' }
          catch (error) { return String(error instanceof TypeError) }
        })(),
        isolated: String(Object.getPrototypeOf(import.meta.dagr) === null),
      }

      export default {
        ci: {
          inspect: {
            deps: [],
            run: () => ({ FROM: 'alpine', steps: [{ ENV: metadata }], IGNORE: [] })
          }
        }
      }
    `
    const root = await fixture(declaration, { 'a/b/dagr.index.js': declaration })

    try {
      const loader = new RepositoryPackageLoader(root)
      const [rootPackage, nestedPackage] = await Promise.all([
        loader.loadPackage('.'),
        loader.loadPackage('a/b'),
      ])
      const inspect = (loaded: Awaited<typeof rootPackage>) => {
        const run = loaded?.definition['ci']?.['inspect']?.run({
          images: {},
          host: { os: 'linux', arch: 'x64' },
        })
        const step = run?.steps[0]
        assert.ok(step && 'ENV' in step)
        return step.ENV
      }

      assert.deepEqual({ ...inspect(rootPackage) }, {
        location: '//',
        immutable: 'true',
        isolated: 'true',
      })
      assert.deepEqual({ ...inspect(nestedPackage) }, {
        location: '//a/b',
        immutable: 'true',
        isolated: 'true',
      })
    } finally {
      await rm(root, { recursive: true })
    }
  })

  it('loads an exact package path without scanning unrelated directories', async () => {
    const root = await fixture('', {
      'a/b/c/dagr.index.js': `
        export default {
          dev: {
            sync: {
              deps: [],
              run: () => ({ FROM: 'alpine', steps: [], IGNORE: [] })
            }
          }
        }
      `,
      'packages/broken/dagr.index.js': 'this is not JavaScript',
    })

    try {
      const loader = new RepositoryPackageLoader(root)
      const first = loader.loadPackage('a/b/c')
      const second = loader.loadPackage('a/b/c')

      assert.equal(first, second)
      assert.equal((await first)?.definition['dev']?.['sync']?.deps.length, 0)
    } finally {
      await rm(root, { recursive: true })
    }
  })

  it('resolves a root-config mount and materializes it once on demand', async () => {
    const root = await fixture('', {
      'a/b/dagr.index.js': `
        export default { '/': 'github.com/acme/tools' }
      `,
    })
    const mountedRoot = await mkdtemp(join(tmpdir(), 'dagr-mounted-'))
    for (const name of ['c', 'd']) {
      await mkdir(join(mountedRoot, name), { recursive: true })
      await writeFile(join(mountedRoot, name, 'dagr.index.js'), `
        export default {
          ci: {
            pack: {
              deps: [],
              run: () => ({ FROM: 'alpine', steps: [], IGNORE: [] })
            }
          }
        }
      `)
    }
    const calls: unknown[][] = []
    const materializer: MountMaterializer = {
      materialize: async (...args) => {
        calls.push(args)
        return { root: mountedRoot }
      },
    }

    try {
      const loader = new RepositoryPackageLoader(root, materializer)
      const [c, d] = await Promise.all([
        loader.loadPackage('a/b//c'),
        loader.loadPackage('a/b//d'),
      ])

      assert.equal(c?.context, join(mountedRoot, 'c'))
      assert.equal(d?.context, join(mountedRoot, 'd'))
      assert.deepEqual(calls, [[
        { FROM: 'github.com/acme/tools', steps: [], IGNORE: [] },
        'github.com/acme/tools',
      ]])
    } finally {
      await Promise.all([
        rm(root, { recursive: true }),
        rm(mountedRoot, { recursive: true }),
      ])
    }
  })

  it('loads root-relative dagr JavaScript, JSON, YAML, and TOML imports', async () => {
    const root = await fixture(
      `
        import { base } from '//config/dagr.base.js'
        import json from '//config/dagr.values.json'
        import yaml from '//config/dagr.values.yaml'
        import toml from '//config/dagr.values.toml'

        export default {
          ci: {
            build: {
              deps: [],
              run: () => ({
                FROM: base,
                steps: [{ ENV: { JSON: json.value, YAML: yaml.value, TOML: toml.value } }],
                IGNORE: []
              })
            }
          }
        }
      `,
      {
        'config/dagr.base.js': `export const base = 'node:22-alpine'`,
        'config/dagr.values.json': `{ "value": "json" }`,
        'config/dagr.values.yaml': `value: yaml`,
        'config/dagr.values.toml': `value = "toml"`,
      }
    )

    try {
      const packages = await new RepositoryPackageLoader(root).loadAllPackages()
      const run = packages.get('.')?.definition['ci']?.['build']?.run({
        images: {},
        host: { os: 'linux', arch: 'x64' },
      })
      assert.equal(
        JSON.stringify(run?.steps),
        JSON.stringify([{ ENV: { JSON: 'json', YAML: 'yaml', TOML: 'toml' } }])
      )
    } finally {
      await rm(root, { recursive: true })
    }
  })

  it('exposes YAML and TOML stringifiers as Dagr built-in modules', async () => {
    const value = {
      name: 'dagr',
      nested: { enabled: true },
      items: ['plain', 'two\nlines'],
      empty: {},
    }
    const root = await fixture(
      `
        import { yaml, toml, exports, same } from '//lib/dagr.formats.js'

        export default {
          ci: {
            build: {
              deps: [],
              run: () => ({
                FROM: 'alpine',
                steps: [{ ENV: { YAML: yaml, TOML: toml, EXPORTS: exports, SAME: same } }],
                IGNORE: []
              })
            }
          }
        }
      `,
      {
        'lib/dagr.formats.js': `
          import YAML, { stringify as stringifyYaml } from 'dagr:yaml'
          import TOML, { stringify as stringifyToml } from 'dagr:toml'
          import * as YAMLModule from 'dagr:yaml'
          import * as TOMLModule from 'dagr:toml'

          const value = ${JSON.stringify(value)}
          export const yaml = YAML.stringify(value)
          export const toml = TOML.stringify(value)
          export const exports = [Object.keys(YAMLModule), Object.keys(TOMLModule)].flat().join(',')
          export const same = String(
            YAML.stringify === stringifyYaml && TOML.stringify === stringifyToml
          )
        `,
      },
    )

    try {
      const loaded = await new RepositoryPackageLoader(root).loadPackage('.')
      const run = loaded?.definition['ci']?.['build']?.run({
        images: {},
        host: { os: 'linux', arch: 'x64' },
      })
      const step = run?.steps[0]
      assert.ok(step && 'ENV' in step)
      const env = step.ENV

      assert.deepEqual(parseYaml(env?.['YAML'] ?? ''), value)
      assert.deepEqual(parseToml(env?.['TOML'] ?? ''), value)
      assert.equal(env?.['EXPORTS'], 'default,stringify,default,stringify')
      assert.equal(env?.['SAME'], 'true')
    } finally {
      await rm(root, { recursive: true })
    }
  })

  for (const [name, source, message] of [
    [
      'unknown Dagr built-in',
      `import 'dagr:json'; export default {}`,
      'Unknown Dagr built-in module: dagr:json',
    ],
    [
      'unexposed built-in export',
      `import { parse } from 'dagr:yaml'; export default parse`,
      "does not provide an export named 'parse'",
    ],
  ] as const) {
    it(`rejects an ${name}`, async () => {
      const root = await fixture(source)
      try {
        await assert.rejects(
          new RepositoryPackageLoader(root).loadPackage('.'),
          new RegExp(message),
        )
      } finally {
        await rm(root, { recursive: true })
      }
    })
  }

  it('withholds ambient Node capabilities and disables dynamic code generation', async () => {
    const root = await fixture(`
      const checks = {
        date: typeof Date,
        random: typeof Math.random,
        intl: typeof Intl,
        console: typeof console,
        timers: typeof setTimeout,
        fetch: typeof fetch,
        process: typeof process,
        require: typeof require,
        dynamicCode: (() => {
          try { Function('return 1')(); return 'allowed' }
          catch (error) { return error.name }
        })(),
        json: JSON.stringify({ value: true }),
        base64: Buffer.from('dagr').toString('base64'),
      }

      export default {
        ci: {
          build: {
            deps: [],
            run: () => ({ FROM: 'alpine', steps: [{ ENV: checks }], IGNORE: [] })
          }
        }
      }
    `)

    try {
      const loaded = await new RepositoryPackageLoader(root).loadPackage('.')
      const run = loaded?.definition['ci']?.['build']?.run({
        images: {},
        host: { os: 'linux', arch: 'x64' },
      })
      const step = run?.steps[0]
      assert.ok(step && 'ENV' in step)
      assert.deepEqual({ ...step.ENV }, {
        date: 'function',
        random: 'function',
        intl: 'object',
        console: 'object',
        timers: 'undefined',
        fetch: 'undefined',
        process: 'undefined',
        require: 'undefined',
        dynamicCode: 'EvalError',
        json: '{"value":true}',
        base64: 'ZGFncg==',
      })
    } finally {
      await rm(root, { recursive: true })
    }
  })

  it('changes the import root after every mount boundary', async () => {
    const root = await fixture('', {
      'a/dagr.index.js': `
        import image from '//b//dagr.util.js'
        export default {
          ci: {
            build: {
              deps: [],
              run: () => ({ FROM: image, steps: [], IGNORE: [] })
            }
          }
        }
      `,
      'b/dagr.index.js': `
        export default { '/': 'b' }
      `,
    })
    const bRoot = await mkdtemp(join(tmpdir(), 'dagr-mounted-b-'))
    const cRoot = await mkdtemp(join(tmpdir(), 'dagr-mounted-c-'))
    await writeFile(join(bRoot, 'dagr.util.js'), `
      import image from '//c//dagr.util2.js'
      export default image
    `)
    await mkdir(join(bRoot, 'c'), { recursive: true })
    await writeFile(join(bRoot, 'c', 'dagr.index.js'), `
      export default { '/': 'c' }
    `)
    await writeFile(join(cRoot, 'dagr.util2.js'), `export default 'nested-image'`)
    const calls: string[] = []
    const materializer: MountMaterializer = {
      materialize: async (_mount, id) => {
        calls.push(id)
        return id === 'b' ? { root: bRoot } : { root: cRoot }
      },
    }

    try {
      const loaded = await new RepositoryPackageLoader(root, materializer).loadPackage('a')
      const run = loaded?.definition['ci']?.['build']?.run({
        images: {},
        host: { os: 'linux', arch: 'x64' },
      })

      assert.equal(run?.FROM, 'nested-image')
      assert.deepEqual(calls, ['b', 'c'])
    } finally {
      await Promise.all([
        rm(root, { recursive: true }),
        rm(bRoot, { recursive: true }),
        rm(cRoot, { recursive: true }),
      ])
    }
  })

  for (const [name, specifier, message] of [
    ['relative specifier', './dagr.helper.js', 'must start with //'],
    ['unprefixed filename', '//config/helper.js', 'must target dagr.*.js'],
    ['unlisted extension', '//config/dagr.helper.yml', 'must target dagr.*.js'],
    ['root escape', '//../dagr.helper.js', 'Invalid Dagr import'],
  ] as const) {
    it(`rejects a ${name}`, async () => {
      const root = await fixture(
        `import value from '${specifier}'; export default value`,
        {
          'config/dagr.helper.js': 'export default {}',
          'config/helper.js': 'export default {}',
          'config/dagr.helper.yml': 'value: true',
        }
      )

      try {
        await assert.rejects(
          new RepositoryPackageLoader(root).loadAllPackages(),
          new RegExp(message.replaceAll('*', '\\*')),
        )
      } finally {
        await rm(root, { recursive: true })
      }
    })
  }

  it('keeps mounts opaque during repository discovery', async () => {
    const root = await fixture('', {
      '.dagr/config.js': `export const mount = () => undefined`,
      'packages/tools/dagr.index.js': `
        export default {
          '/': 'github.com/acme/unresolved'
        }
      `,
    })
    const mountedRoot = await mkdtemp(join(tmpdir(), 'dagr-mounted-'))
    await writeFile(join(mountedRoot, 'dagr.index.js'), `export default { ci: {} }`)
    const calls: string[] = []
    const materializer: MountMaterializer = {
      materialize: async (_mount, id) => {
        calls.push(id)
        return { root: mountedRoot }
      },
    }

    try {
      const packages = await new RepositoryPackageLoader(root, materializer).loadAllPackages()
      assert.deepEqual([...packages.keys()], [])
      assert.deepEqual(calls, [])
    } finally {
      await Promise.all([
        rm(root, { recursive: true }),
        rm(mountedRoot, { recursive: true }),
      ])
    }
  })

  it('fails only when traversal reaches an unresolved mount ID', async () => {
    const root = await fixture('', {
      '.dagr/config.js': `export const mount = () => undefined`,
      'vendor/foo/dagr.index.js': `
        export default { '/': 'github.com/acme/missing' }
      `,
    })
    try {
      await assert.rejects(
        new RepositoryPackageLoader(root).loadPackage('vendor/foo//pkg'),
        (error: Error) => {
          assert.match(error.message, /github\.com\/acme\/missing/)
          assert.match(error.message, /\/\/vendor\/foo/)
          return true
        },
      )
    } finally {
      await rm(root, { recursive: true })
    }
  })

  it('rejects a non-string mount ID when the declaration is loaded', async () => {
    const root = await fixture('', {
      'vendor/foo/dagr.index.js': `
        export default { '/': { FROM: 'foo', steps: [], IGNORE: [] } }
      `,
    })

    try {
      await assert.rejects(
        new RepositoryPackageLoader(root).loadAllPackages(),
        /Invalid mount declaration at \/\/vendor\/foo:.*mount ID must be a string/s,
      )
    } finally {
      await rm(root, { recursive: true })
    }
  })

  it('reuses one mounted filesystem for the same ID at different addresses', async () => {
    const mount = `export default { '/': 'tools' }`
    const root = await fixture('', {
      'packages/left/dagr.index.js': mount,
      'packages/right/dagr.index.js': mount,
    })
    const mountedRoot = await mkdtemp(join(tmpdir(), 'dagr-mounted-'))
    await mkdir(join(mountedRoot, 'c'), { recursive: true })
    await writeFile(join(mountedRoot, 'c', 'dagr.index.js'), `
      const location = import.meta.dagr.location
      export default {
        ci: {
          inspect: {
            deps: [],
            run: () => ({ FROM: location, steps: [], IGNORE: [] })
          }
        }
      }
    `)
    let calls = 0
    const materializer: MountMaterializer = {
      materialize: async () => {
        calls++
        return { root: mountedRoot }
      },
    }

    try {
      const loader = new RepositoryPackageLoader(root, materializer)
      const [left, right] = await Promise.all([
        loader.loadPackage('packages/left//c'),
        loader.loadPackage('packages/right//c'),
      ])
      const location = (loaded: typeof left) => loaded?.definition['ci']?.['inspect']?.run({
        images: {},
        host: { os: 'linux', arch: 'x64' },
      }).FROM

      assert.equal(location(left), '//c')
      assert.equal(location(right), '//c')
      assert.equal(left?.context, right?.context)
      assert.equal(calls, 1)
    } finally {
      await Promise.all([
        rm(root, { recursive: true }),
        rm(mountedRoot, { recursive: true }),
      ])
    }
  })

  it('resolves a shared mount ID once across a diamond', async () => {
    const root = await fixture('', {
      '.dagr/config.js': `
        export const mount = id => ({ FROM: 'root:' + id, steps: [], IGNORE: [] })
      `,
      'vendor/left/dagr.index.js': `export default { '/': 'left' }`,
      'vendor/right/dagr.index.js': `export default { '/': 'right' }`,
    })
    const leftRoot = await mkdtemp(join(tmpdir(), 'dagr-mounted-left-'))
    const rightRoot = await mkdtemp(join(tmpdir(), 'dagr-mounted-right-'))
    const sharedRoot = await mkdtemp(join(tmpdir(), 'dagr-mounted-shared-'))
    for (const mountedRoot of [leftRoot, rightRoot]) {
      await mkdir(join(mountedRoot, 'shared'), { recursive: true })
      await mkdir(join(mountedRoot, '.dagr'))
      await writeFile(
        join(mountedRoot, 'shared', 'dagr.index.js'),
        `export default { '/': 'github.com/acme/shared' }`,
      )
      await writeFile(
        join(mountedRoot, '.dagr/config.js'),
        `export const mount = () => ({ FROM: 'mounted-config', steps: [], IGNORE: [] })`,
      )
    }
    await mkdir(join(sharedRoot, 'pkg'), { recursive: true })
    await writeFile(join(sharedRoot, 'pkg', 'dagr.index.js'), `
      export default {
        ci: {
          build: {
            deps: [],
            run: () => ({ FROM: 'alpine', steps: [], IGNORE: [] })
          }
        }
      }
    `)
    const calls: Array<{ id: string; from: string }> = []
    const materializer: MountMaterializer = {
      materialize: async (mount, id) => {
        calls.push({ id, from: mount.FROM })
        if (id === 'left') return { root: leftRoot }
        if (id === 'right') return { root: rightRoot }
        return { root: sharedRoot }
      },
    }

    try {
      const loader = new RepositoryPackageLoader(root, materializer)
      const [left, right] = await Promise.all([
        loader.loadPackage('vendor/left//shared//pkg'),
        loader.loadPackage('vendor/right//shared//pkg'),
      ])

      assert.equal(left?.context, join(sharedRoot, 'pkg'))
      assert.equal(right?.context, join(sharedRoot, 'pkg'))
      assert.deepEqual(calls.map(call => call.id).sort(), [
        'github.com/acme/shared',
        'left',
        'right',
      ])
      assert.equal(
        calls.find(call => call.id === 'github.com/acme/shared')?.from,
        'root:github.com/acme/shared',
      )
    } finally {
      await Promise.all([
        rm(root, { recursive: true }),
        rm(leftRoot, { recursive: true }),
        rm(rightRoot, { recursive: true }),
        rm(sharedRoot, { recursive: true }),
      ])
    }
  })

  it('preserves every nested mount boundary in the package identity', async () => {
    const mountIndex = (id: string) => `
      export default {
        '/': '${id}'
      }
    `
    const root = await fixture('', {
      'packages/tools/dagr.index.js': mountIndex('outer'),
    })
    const outerRoot = await mkdtemp(join(tmpdir(), 'dagr-mounted-'))
    const innerRoot = await mkdtemp(join(tmpdir(), 'dagr-mounted-'))
    await mkdir(join(outerRoot, 'c', 'd'), { recursive: true })
    await writeFile(join(outerRoot, 'c', 'd', 'dagr.index.js'), mountIndex('inner'))
    await mkdir(join(innerRoot, 'e'), { recursive: true })
    await writeFile(join(innerRoot, 'e', 'dagr.index.js'), `
      export default {
        ci: {
          pack: {
            deps: [],
            run: () => ({ FROM: 'alpine', steps: [], IGNORE: [] })
          }
        }
      }
    `)
    const materializer: MountMaterializer = {
      materialize: async (_mount, id) => id === 'outer'
        ? { root: outerRoot }
        : { root: innerRoot },
    }

    try {
      const loader = new RepositoryPackageLoader(root, materializer)
      assert.ok(await loader.loadPackage('packages/tools//c/d//e'))
      assert.equal(await loader.loadPackage('packages/tools/c/d/e'), undefined)
    } finally {
      await Promise.all([
        rm(root, { recursive: true }),
        rm(outerRoot, { recursive: true }),
        rm(innerRoot, { recursive: true }),
      ])
    }
  })

  it('detects recursive mounts by global mount ID', async () => {
    const declaration = `
      export default {
        '/': 'recursive'
      }
    `
    const root = await fixture('', { 'packages/loop/dagr.index.js': declaration })
    const mountedRoot = await mkdtemp(join(tmpdir(), 'dagr-mounted-'))
    await writeFile(join(mountedRoot, 'dagr.index.js'), declaration)
    const materializer: MountMaterializer = {
      materialize: async () => ({
        root: mountedRoot,
      }),
    }

    try {
      await assert.rejects(
        new RepositoryPackageLoader(root, materializer).loadPackage('packages/loop////'),
        /Circular mount: \/\/packages\/loop -> \/\/packages\/loop\/\//,
      )
    } finally {
      await Promise.all([
        rm(root, { recursive: true }),
        rm(mountedRoot, { recursive: true }),
      ])
    }
  })
})
