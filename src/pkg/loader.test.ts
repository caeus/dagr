import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { loadPackages, type MountMaterializer } from '#pkg/loader.js'

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

describe('loadPackages', () => {
  it('loads root-relative dagr JavaScript, JSON, YAML, and TOML imports', async () => {
    const root = await fixture(
      `
        import { base } from '/config/dagr.base.js'
        import json from '/config/dagr.values.json'
        import yaml from '/config/dagr.values.yaml'
        import toml from '/config/dagr.values.toml'

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
      const { definitions: packages } = await loadPackages(root)
      const run = packages.get('.')?.['ci']?.['build']?.run({
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

  for (const [name, specifier, message] of [
    ['relative specifier', './dagr.helper.js', 'must start with /'],
    ['unprefixed filename', '/config/helper.js', 'must target dagr.*.js'],
    ['unlisted extension', '/config/dagr.helper.yml', 'must target dagr.*.js'],
    ['root escape', '/../dagr.helper.js', 'must stay inside the monorepo root'],
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
        await assert.rejects(loadPackages(root), new RegExp(message.replaceAll('*', '\\*')))
      } finally {
        await rm(root, { recursive: true })
      }
    })
  }

  it('replaces a mount directory with packages from the materialized workdir', async () => {
    const root = await fixture('', {
      'packages/tools/dagr.index.js': `
        export default {
          '#mount': { FROM: 'tools:latest', steps: [], IGNORE: [] }
        }
      `,
    })
    const mountedRoot = await mkdtemp(join(tmpdir(), 'dagr-mounted-'))
    await mkdir(join(mountedRoot, 'c'), { recursive: true })
    await writeFile(join(mountedRoot, 'dagr.shared.js'), `export const image = 'alpine'`)
    await writeFile(join(mountedRoot, 'c', 'dagr.index.js'), `
      import { image } from '/dagr.shared.js'
      export default {
        ci: {
          pack: {
            deps: [],
            run: () => ({ FROM: image, steps: [], IGNORE: [] })
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
      const { definitions: packages, contexts } = await loadPackages(root, materializer)
      const run = packages.get('packages/tools//c')?.['ci']?.['pack']?.run({
        images: {},
        host: { os: 'linux', arch: 'x64' },
      })

      assert.equal(run?.FROM, 'alpine')
      assert.equal(contexts.get('packages/tools//c'), join(mountedRoot, 'c'))
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
          '#mount': { FROM: 'tools:latest', steps: [], IGNORE: [] }
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
      const { definitions, contexts } = await loadPackages(root, materializer)
      assert.equal(definitions.has('packages/tools//'), true)
      assert.equal(definitions.has('packages/tools'), false)
      assert.equal(contexts.get('packages/tools//'), mountedRoot)
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
        '#mount': { FROM: '${image}', steps: [], IGNORE: [] }
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
      const { definitions } = await loadPackages(root, materializer)
      assert.equal(definitions.has('packages/tools//c/d//e'), true)
      assert.equal(definitions.has('packages/tools/c/d/e'), false)
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
        '#mount': { FROM: 'recursive:latest', steps: [], IGNORE: [] }
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
      await assert.rejects(loadPackages(root, materializer), /Circular mount: packages\/loop -> packages\/loop/)
    } finally {
      await Promise.all([
        rm(root, { recursive: true }),
        rm(mountedRoot, { recursive: true }),
      ])
    }
  })
})
