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
  await writeFile(join(root, 'dagr.index.js'), marker)
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, contents)
  }
  return root
}

describe('RepositoryPackageLoader', () => {
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
      'a/b/dagr.index.js': `
        export default { '/': { FROM: 'tools', steps: [], IGNORE: [] } }
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
    let calls = 0
    const materializer: MountMaterializer = {
      materialize: async () => {
        calls++
        return { root: mountedRoot, identity: 'sha256:tools:/work' }
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
        import { yaml, toml, exports } from '//lib/dagr.formats.js'

        export default {
          ci: {
            build: {
              deps: [],
              run: () => ({
                FROM: 'alpine',
                steps: [{ ENV: { YAML: yaml, TOML: toml, EXPORTS: exports } }],
                IGNORE: []
              })
            }
          }
        }
      `,
      {
        'lib/dagr.formats.js': `
          import * as YAML from 'dagr:yaml'
          import * as TOML from 'dagr:toml'

          const value = ${JSON.stringify(value)}
          export const yaml = YAML.stringify(value)
          export const toml = TOML.stringify(value)
          export const exports = [Object.keys(YAML), Object.keys(TOML)].flat().join(',')
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
      assert.equal(env?.['EXPORTS'], 'stringify,stringify')
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
        export default { '/': { FROM: 'b', steps: [], IGNORE: [] } }
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
      export default { '/': { FROM: 'c', steps: [], IGNORE: [] } }
    `)
    await writeFile(join(cRoot, 'dagr.util2.js'), `export default 'nested-image'`)
    const calls: string[] = []
    const materializer: MountMaterializer = {
      materialize: async (_mount, logicalPath) => {
        calls.push(logicalPath)
        return logicalPath === 'b'
          ? { root: bRoot, identity: 'sha256:b:/work' }
          : { root: cRoot, identity: 'sha256:c:/work' }
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

  it('replaces a mount directory with packages from the materialized workdir', async () => {
    const root = await fixture('', {
      'packages/tools/dagr.index.js': `
        export default {
          '/': { FROM: 'tools:latest', steps: [], IGNORE: [] }
        }
      `,
    })
    const mountedRoot = await mkdtemp(join(tmpdir(), 'dagr-mounted-'))
    await mkdir(join(mountedRoot, 'c'), { recursive: true })
    await writeFile(join(mountedRoot, 'dagr.shared.js'), `
      import { stringify } from 'dagr:yaml'
      export const image = 'alpine'
      export const encoded = stringify({ mounted: true })
    `)
    await writeFile(join(mountedRoot, 'c', 'dagr.index.js'), `
      import { encoded, image } from '//dagr.shared.js'
      export default {
        ci: {
          pack: {
            deps: [],
            run: () => ({ FROM: image, steps: [{ ENV: { ENCODED: encoded } }], IGNORE: [] })
          }
        }
      }
    `)
    const calls: string[] = []
    const materializer: MountMaterializer = {
      materialize: async (_mount, logicalPath) => {
        calls.push(logicalPath)
        return { root: mountedRoot, identity: 'sha256:tools:/work' }
      },
    }

    try {
      const packages = await new RepositoryPackageLoader(root, materializer).loadAllPackages()
      const loaded = packages.get('packages/tools//c')
      const run = loaded?.definition['ci']?.['pack']?.run({
        images: {},
        host: { os: 'linux', arch: 'x64' },
      })

      assert.equal(run?.FROM, 'alpine')
      const step = run?.steps[0]
      assert.ok(step && 'ENV' in step)
      assert.deepEqual(parseYaml(step.ENV['ENCODED'] ?? ''), { mounted: true })
      assert.equal(loaded?.context, join(mountedRoot, 'c'))
      assert.equal(packages.has('packages/tools/c'), false)
      assert.equal(calls.length, 1)
      assert.equal(calls[0], 'packages/tools')
    } finally {
      await Promise.all([
        rm(root, { recursive: true }),
        rm(mountedRoot, { recursive: true }),
      ])
    }
  })

  it('marks a package at the mounted WORKDIR root with a trailing boundary', async () => {
    const root = await fixture('', {
      'packages/tools/dagr.index.js': `
        export default {
          '/': { FROM: 'tools:latest', steps: [], IGNORE: [] }
        }
      `,
    })
    const mountedRoot = await mkdtemp(join(tmpdir(), 'dagr-mounted-'))
    await writeFile(join(mountedRoot, 'dagr.index.js'), `
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
      materialize: async () => ({
        root: mountedRoot,
        identity: 'sha256:tools:/work',
      }),
    }

    try {
      const packages = await new RepositoryPackageLoader(root, materializer).loadAllPackages()
      assert.equal(packages.has('packages/tools//'), true)
      assert.equal(packages.has('packages/tools'), false)
      assert.equal(packages.get('packages/tools//')?.context, mountedRoot)
    } finally {
      await Promise.all([
        rm(root, { recursive: true }),
        rm(mountedRoot, { recursive: true }),
      ])
    }
  })

  it('preserves every nested mount boundary in the package identity', async () => {
    const mountIndex = (image: string) => `
      export default {
        '/': { FROM: '${image}', steps: [], IGNORE: [] }
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
      materialize: async (_mount, logicalPath) => logicalPath === 'packages/tools'
        ? { root: outerRoot, identity: 'sha256:outer:/work' }
        : { root: innerRoot, identity: 'sha256:inner:/work' },
    }

    try {
      const packages = await new RepositoryPackageLoader(root, materializer).loadAllPackages()
      assert.equal(packages.has('packages/tools//c/d//e'), true)
      assert.equal(packages.has('packages/tools/c/d/e'), false)
    } finally {
      await Promise.all([
        rm(root, { recursive: true }),
        rm(outerRoot, { recursive: true }),
        rm(innerRoot, { recursive: true }),
      ])
    }
  })

  it('detects recursive mounts by materialized image identity', async () => {
    const declaration = `
      export default {
        '/': { FROM: 'recursive:latest', steps: [], IGNORE: [] }
      }
    `
    const root = await fixture('', { 'packages/loop/dagr.index.js': declaration })
    const mountedRoot = await mkdtemp(join(tmpdir(), 'dagr-mounted-'))
    await writeFile(join(mountedRoot, 'dagr.index.js'), declaration)
    const materializer: MountMaterializer = {
      materialize: async () => ({
        root: mountedRoot,
        identity: 'sha256:recursive:/work',
      }),
    }

    try {
      await assert.rejects(
        new RepositoryPackageLoader(root, materializer).loadAllPackages(),
        /Circular mount: packages\/loop -> packages\/loop/,
      )
    } finally {
      await Promise.all([
        rm(root, { recursive: true }),
        rm(mountedRoot, { recursive: true }),
      ])
    }
  })
})
