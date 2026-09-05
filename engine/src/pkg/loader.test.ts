import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { parse as parseToml } from 'smol-toml'
import { parse as parseYaml } from 'yaml'
import { RepositoryPackageLoader, type VolumeMaterializer } from '#pkg/loader.js'

async function fixture(
  marker: string,
  files: Readonly<Record<string, string>> = {}
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dagr-loader-'))
  await mkdir(join(root, 'packages'))
  await mkdir(join(root, '.dagr'))
  if (marker) await writeFile(join(root, 'dagr.index.js'), marker)
  await writeFile(join(root, '.dagr/config.js'), `
    export const identifyVolume = request => request.id
  `)
  await writeFile(join(root, '.dagr/volumes.yaml'), `
tools: &volume
  FROM: tools
  steps: []
  IGNORE: []
b: *volume
c: *volume
outer: *volume
inner: *volume
recursive: *volume
`)
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, contents)
  }
  return root
}

describe('RepositoryPackageLoader', () => {
  it('reports an invalid index with its logical package path', async () => {
    const root = await fixture('', {
      'packages/broken/dagr.index.js': 'export default { ci: { build: {} } }\n',
    })

    try {
      await assert.rejects(
        new RepositoryPackageLoader(root).loadPackage('packages/broken'),
        error => {
          assert.match(String(error), /Invalid Dagr index at \/\/packages\/broken/)
          assert.match(String(error), /deps/)
          assert.match(String(error), /run/)
          return true
        },
      )
    } finally {
      await rm(root, { recursive: true })
    }
  })

  it('reports an index whose exported value is cyclic', async () => {
    const root = await fixture('', {
      'packages/broken/dagr.index.js': `
        const cyclic = {}
        cyclic.self = cyclic
        export default cyclic
      `,
    })

    try {
      await assert.rejects(
        new RepositoryPackageLoader(root).loadPackage('packages/broken'),
        /Invalid Dagr index at \/\/packages\/broken/,
      )
    } finally {
      await rm(root, { recursive: true })
    }
  })

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
      '.dagr/bootstrap/dagr.index.js': declaration,
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

  it('materializes a mount once while loading packages below it on demand', async () => {
    const root = await fixture('', {
      'a/b/dagr.mount.yaml': 'id: tools\n',
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
    let calls = 0
    const materializer: VolumeMaterializer = {
      materialize: async () => {
        calls++
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
      assert.equal(calls, 1)
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
      'b/dagr.mount.yaml': 'id: b\n',
    })
    const bRoot = await mkdtemp(join(tmpdir(), 'dagr-mounted-b-'))
    const cRoot = await mkdtemp(join(tmpdir(), 'dagr-mounted-c-'))
    await writeFile(join(bRoot, 'dagr.util.js'), `
      import image from '//c//dagr.util2.js'
      export default image
    `)
    await mkdir(join(bRoot, 'c'), { recursive: true })
    await writeFile(join(bRoot, 'c', 'dagr.mount.yaml'), 'id: c\n')
    await writeFile(join(cRoot, 'dagr.util2.js'), `export default 'nested-image'`)
    const calls: string[] = []
    const materializer: VolumeMaterializer = {
      materialize: async (_id, _implementation, logicalPath) => {
        calls.push(logicalPath)
        return logicalPath === 'b'
          ? { root: bRoot }
          : { root: cRoot }
      },
    }

    try {
      const loaded = await new RepositoryPackageLoader(root, materializer).loadPackage('a')
      const run = loaded?.definition['ci']?.['build']?.run({
        images: {},
        host: { os: 'linux', arch: 'x64' },
      })

      assert.equal(run?.FROM, 'nested-image')
      assert.deepEqual(calls, ['b', 'b//c'])
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
      'packages/tools/dagr.mount.yaml': 'id: tools\n',
    })
    const mountedRoot = await mkdtemp(join(tmpdir(), 'dagr-mounted-'))
    await writeFile(join(mountedRoot, 'dagr.index.js'), `export default { ci: {} }`)
    const calls: string[] = []
    const materializer: VolumeMaterializer = {
      materialize: async (_id, _implementation, logicalPath) => {
        calls.push(logicalPath)
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

  it('does not expose the mounter through a mounted package location', async () => {
    const root = await fixture('', {
      'packages/left/dagr.mount.yaml': 'id: tools\n',
      'packages/right/dagr.mount.yaml': 'id: tools\n',
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
    const materializer: VolumeMaterializer = {
      materialize: async () => ({
        root: mountedRoot,
      }),
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
    } finally {
      await Promise.all([
        rm(root, { recursive: true }),
        rm(mountedRoot, { recursive: true }),
      ])
    }
  })

  it('preserves every nested mount boundary in the package identity', async () => {
    const root = await fixture('', {
      'packages/tools/dagr.mount.yaml': 'id: outer\n',
    })
    const outerRoot = await mkdtemp(join(tmpdir(), 'dagr-mounted-'))
    const innerRoot = await mkdtemp(join(tmpdir(), 'dagr-mounted-'))
    await mkdir(join(outerRoot, 'c', 'd'), { recursive: true })
    await writeFile(join(outerRoot, 'c', 'd', 'dagr.mount.yaml'), 'id: inner\n')
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
    const materializer: VolumeMaterializer = {
      materialize: async (_id, _implementation, logicalPath) => logicalPath === 'packages/tools'
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

  it('detects recursive mounts by global volume identity', async () => {
    const declaration = 'id: recursive\n'
    const root = await fixture('', { 'packages/loop/dagr.mount.yaml': declaration })
    const mountedRoot = await mkdtemp(join(tmpdir(), 'dagr-mounted-'))
    await writeFile(join(mountedRoot, 'dagr.mount.yaml'), declaration)
    const materializer: VolumeMaterializer = {
      materialize: async () => ({
        root: mountedRoot,
      }),
    }

    try {
      await assert.rejects(
        new RepositoryPackageLoader(root, materializer).loadPackage('packages/loop////'),
        /Circular volume "recursive": \/\/packages\/loop -> \/\/packages\/loop\/\//,
      )
    } finally {
      await Promise.all([
        rm(root, { recursive: true }),
        rm(mountedRoot, { recursive: true }),
      ])
    }
  })
})
