import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { RootVolumeRegistry } from '#pkg/volume-registry.js'

async function rootWith(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dagr-volume-registry-'))
  await mkdir(join(root, '.dagr'))
  await Promise.all(Object.entries(files).map(async ([path, contents]) => {
    const target = join(root, path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, contents)
  }))
  return root
}

const VALID_VOLUMES = `
example:
  FROM: alpine
  steps: []
  IGNORE: []
`

describe('RootVolumeRegistry', () => {
  it('reports missing, invalid, and import-using root identity policies with the mount path', async t => {
    const cases = [
      {
        name: 'missing config',
        config: undefined,
        expected: /Root \.dagr\/config\.js is missing/,
      },
      {
        name: 'missing export',
        config: 'export const somethingElse = true\n',
        expected: /must export an identifyVolume function/,
      },
      {
        name: 'syntax error',
        config: 'export const identifyVolume = request => {\n',
        expected: /Cannot evaluate root \.dagr\/config\.js/,
      },
      {
        name: 'imports are unsupported',
        config: "import './helper.js'\nexport const identifyVolume = request => request.repo\n",
        expected: /cannot import \.\/helper\.js/,
      },
    ] as const

    for (const entry of cases) await t.test(entry.name, async () => {
      const root = await rootWith({
        '.dagr/volumes.yaml': VALID_VOLUMES,
        ...(entry.config === undefined ? {} : { '.dagr/config.js': entry.config }),
      })
      try {
        await assert.rejects(
          new RootVolumeRegistry(root).resolve({ repo: 'example' }, 'vendor/foo'),
          error => {
            assert.match(messages(error), /Cannot identify volume requested through mount \/\/vendor\/foo/)
            assert.match(messages(error), entry.expected)
            return true
          },
        )
      } finally {
        await rm(root, { recursive: true })
      }
    })
  })

  it('reports identity function failures and non-string results with the mount path', async t => {
    const cases = [
      {
        name: 'function throws',
        config: 'export const identifyVolume = () => { throw new Error("bad request") }\n',
        expected: /Root identifyVolume failed.*\/\/vendor\/foo/,
      },
      {
        name: 'non-string result',
        config: 'export const identifyVolume = () => ({ id: "example" })\n',
        expected: /must return a string synchronously.*\/\/vendor\/foo; received object/,
      },
      {
        name: 'dynamic imports are unsupported',
        config: 'export const identifyVolume = () => import("./helper.js")\n',
        expected: /must return a string synchronously.*\/\/vendor\/foo; received promise/,
      },
    ] as const

    for (const entry of cases) await t.test(entry.name, async () => {
      const root = await rootWith({
        '.dagr/config.js': entry.config,
        '.dagr/volumes.yaml': VALID_VOLUMES,
      })
      try {
        await assert.rejects(
          new RootVolumeRegistry(root).resolve({ repo: 'example' }, 'vendor/foo'),
          error => {
            assert.match(messages(error), entry.expected)
            return true
          },
        )
      } finally {
        await rm(root, { recursive: true })
      }
    })
  })

  it('evaluates identity policy with minimal globals and a sandbox-owned frozen request', async () => {
    const root = await rootWith({
      '.dagr/config.js': `
        let dynamicImportEscaped = false
        try { await import('./forbidden.js') }
        catch (error) {
          try {
            dynamicImportEscaped = Boolean(
              error.constructor.constructor('return process')()
            )
          } catch {}
        }

        const exposed = [
          ['Atomics', typeof Atomics],
          ['Buffer', typeof Buffer],
          ['Date', typeof Date],
          ['FinalizationRegistry', typeof FinalizationRegistry],
          ['Function', typeof Function],
          ['Intl', typeof Intl],
          ['SharedArrayBuffer', typeof SharedArrayBuffer],
          ['WeakRef', typeof WeakRef],
          ['WebAssembly', typeof WebAssembly],
          ['console', typeof console],
          ['eval', typeof eval],
          ['fetch', typeof fetch],
          ['process', typeof process],
          ['require', typeof require],
          ['setTimeout', typeof setTimeout],
          ['Math.random', typeof Math.random],
        ].filter(([, type]) => type !== 'undefined')

        const escapes = request => [
          () => request.constructor.constructor('return process')(),
          () => globalThis.constructor.constructor('return process')(),
          () => ({}).constructor.constructor('return process')(),
          () => (async () => {}).constructor('return process')(),
        ].some(attempt => {
          try { return Boolean(attempt()) }
          catch { return false }
        })

        export const identifyVolume = request => {
          if (exposed.length) return 'exposed:' + exposed.map(([name]) => name).join(',')
          if (dynamicImportEscaped || escapes(request)) return 'escaped'
          if (!Object.isFrozen(request) || !Object.isFrozen(request.nested)) return 'mutable'
          try { request.repo = 'mutated' } catch {}
          return request.repo
        }
      `,
      '.dagr/volumes.yaml': VALID_VOLUMES,
    })

    try {
      const resolved = await new RootVolumeRegistry(root).resolve(
        { repo: 'example', nested: { enabled: true } },
        'vendor/foo',
      )
      assert.equal(resolved.id, 'example')
    } finally {
      await rm(root, { recursive: true })
    }
  })

  it('reports malformed and invalid volume definitions with the volume ID and mount path', async t => {
    const cases = [
      { name: 'malformed YAML', volumes: 'example: [\n', expected: /Cannot parse root \.dagr\/volumes\.yaml/ },
      { name: 'invalid schema', volumes: 'example:\n  FROM: alpine\n', expected: /Invalid root \.dagr\/volumes\.yaml/ },
      { name: 'cyclic aliases', volumes: '&volumes\nexample: *volumes\n', expected: /Invalid root \.dagr\/volumes\.yaml/ },
    ] as const

    for (const entry of cases) await t.test(entry.name, async () => {
      const root = await rootWith({
        '.dagr/config.js': 'export const identifyVolume = request => request.repo\n',
        '.dagr/volumes.yaml': entry.volumes,
      })
      try {
        await assert.rejects(
          new RootVolumeRegistry(root).resolve({ repo: 'example' }, 'vendor/foo'),
          error => {
            assert.match(messages(error), /volume "example" requested through mount \/\/vendor\/foo/)
            assert.match(messages(error), entry.expected)
            return true
          },
        )
      } finally {
        await rm(root, { recursive: true })
      }
    })
  })
})

function messages(error: unknown): string {
  const result: string[] = []
  for (let current = error; current instanceof Error; current = current.cause)
    result.push(current.message)
  return result.join('\n')
}
