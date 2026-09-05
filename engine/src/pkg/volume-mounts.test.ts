import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  RepositoryPackageLoader,
  type VolumeMaterializer,
} from '#pkg/loader.js'
import type { MountImplementation } from '#pkg/schema.js'

const PACKAGE = (image = 'alpine') => `
  export default {
    ci: {
      build: {
        deps: [],
        run: () => ({ FROM: ${JSON.stringify(image)}, steps: [], IGNORE: [] })
      }
    }
  }
`

async function writeFiles(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, contents)
  }
}

function volumes(...ids: readonly string[]): string {
  return ids.map(id => `
${JSON.stringify(id)}:
  FROM: ${JSON.stringify(`image:${id}`)}
  steps: []
  IGNORE: []
`).join('')
}

async function repository(
  files: Readonly<Record<string, string>>,
  ids: readonly string[],
  config = 'export const identifyVolume = request => request.repo\n',
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dagr-volumes-'))
  await writeFiles(root, {
    '.dagr/config.js': config,
    '.dagr/volumes.yaml': volumes(...ids),
    ...files,
  })
  return root
}

interface MaterializeCall {
  readonly id: string
  readonly implementation: MountImplementation
  readonly path: string
}

function materializer(
  roots: Readonly<Record<string, string>>,
  calls: MaterializeCall[],
): VolumeMaterializer {
  return {
    materialize: async (id, implementation, path) => {
      calls.push({ id, implementation, path })
      const root = roots[id]
      if (!root) throw new Error(`No test filesystem for volume ${id}`)
      return { root }
    },
  }
}

describe('volume mounts', () => {
  it('resolves a mount request through root config and root volume definitions', async () => {
    const mounted = await mkdtemp(join(tmpdir(), 'dagr-volume-basic-'))
    await writeFiles(mounted, { 'packages/core/dagr.index.js': PACKAGE('core') })
    const root = await repository({
      'vendor/foo/dagr.mount.yaml': 'repo: github.com/acme/foo\nversion: "^3"\n',
    }, ['github.com/acme/foo'])
    const calls: MaterializeCall[] = []

    try {
      const loaded = await new RepositoryPackageLoader(
        root,
        materializer({ 'github.com/acme/foo': mounted }, calls),
      ).loadPackage('vendor/foo//packages/core')

      assert.equal(loaded?.context, join(mounted, 'packages/core'))
      assert.deepEqual(calls.map(call => ({
        id: call.id,
        from: call.implementation.FROM,
        path: call.path,
      })), [{
        id: 'github.com/acme/foo',
        from: 'image:github.com/acme/foo',
        path: 'vendor/foo',
      }])
    } finally {
      await Promise.all([
        rm(root, { recursive: true }),
        rm(mounted, { recursive: true }),
      ])
    }
  })

  it('accepts arbitrary structured YAML mount requests', async () => {
    const mounted = await mkdtemp(join(tmpdir(), 'dagr-volume-structured-'))
    await writeFiles(mounted, { 'dagr.index.js': PACKAGE('structured') })
    const id = 'github.com/acme/foo:linux:true:fast,safe:null'
    const root = await repository({
      'tool/dagr.mount.yaml': `
repo: github.com/acme/foo
variant:
  os: linux
  debug: true
features: [fast, safe]
fallback: null
`,
    }, [id], `
      export const identifyVolume = request =>
        request.repo + ':' + request.variant.os + ':' + request.variant.debug + ':' +
        request.features.join(',') + ':' + request.fallback
    `)
    const calls: MaterializeCall[] = []

    try {
      assert.ok(await new RepositoryPackageLoader(
        root,
        materializer({ [id]: mounted }, calls),
      ).loadPackage('tool//'))
      assert.equal(calls[0]?.id, id)
    } finally {
      await Promise.all([
        rm(root, { recursive: true }),
        rm(mounted, { recursive: true }),
      ])
    }
  })

  it('collapses different requests to one global volume ID', async () => {
    const mounted = await mkdtemp(join(tmpdir(), 'dagr-volume-collapse-'))
    await writeFiles(mounted, { 'pkg/dagr.index.js': PACKAGE() })
    const root = await repository({
      'a/dagr.mount.yaml': 'repo: shared\nversion: 3\n',
      'b/dagr.mount.yaml': 'repo: shared\nversion: 4\n',
    }, ['shared'])
    const calls: MaterializeCall[] = []
    const loader = new RepositoryPackageLoader(root, materializer({ shared: mounted }, calls))

    try {
      await Promise.all([loader.loadPackage('a//pkg'), loader.loadPackage('b//pkg')])
      assert.equal(calls.length, 1)
      assert.equal(calls[0]?.id, 'shared')
    } finally {
      await Promise.all([
        rm(root, { recursive: true }),
        rm(mounted, { recursive: true }),
      ])
    }
  })

  it('keeps different filesystem addresses into the same volume', async () => {
    const mounted = await mkdtemp(join(tmpdir(), 'dagr-volume-addresses-'))
    await writeFiles(mounted, { 'packages/core/dagr.index.js': PACKAGE() })
    const root = await repository({
      'a/foo/dagr.mount.yaml': 'repo: shared\n',
      'b/foo/dagr.mount.yaml': 'repo: shared\n',
    }, ['shared'])
    const calls: MaterializeCall[] = []
    const loader = new RepositoryPackageLoader(root, materializer({ shared: mounted }, calls))

    try {
      const [a, b] = await Promise.all([
        loader.loadPackage('a/foo//packages/core'),
        loader.loadPackage('b/foo//packages/core'),
      ])
      assert.equal(a?.context, join(mounted, 'packages/core'))
      assert.equal(b?.context, join(mounted, 'packages/core'))
      assert.equal(calls.length, 1)
    } finally {
      await Promise.all([
        rm(root, { recursive: true }),
        rm(mounted, { recursive: true }),
      ])
    }
  })

  it('shares a dependency volume across a diamond of imported repositories', async () => {
    const left = await mkdtemp(join(tmpdir(), 'dagr-volume-left-'))
    const right = await mkdtemp(join(tmpdir(), 'dagr-volume-right-'))
    const shared = await mkdtemp(join(tmpdir(), 'dagr-volume-shared-'))
    await writeFiles(left, { 'deps/c/dagr.mount.yaml': 'repo: c\nversion: 1\n' })
    await writeFiles(right, { 'deps/c/dagr.mount.yaml': 'repo: c\nversion: 2\n' })
    await writeFiles(shared, { 'pkg/dagr.index.js': PACKAGE() })
    const root = await repository({
      'imports/left/dagr.mount.yaml': 'repo: left\n',
      'imports/right/dagr.mount.yaml': 'repo: right\n',
    }, ['left', 'right', 'c'])
    const calls: MaterializeCall[] = []
    const loader = new RepositoryPackageLoader(
      root,
      materializer({ left, right, c: shared }, calls),
    )

    try {
      const [fromLeft, fromRight] = await Promise.all([
        loader.loadPackage('imports/left//deps/c//pkg'),
        loader.loadPackage('imports/right//deps/c//pkg'),
      ])
      assert.ok(fromLeft)
      assert.ok(fromRight)
      assert.equal(calls.filter(call => call.id === 'c').length, 1)
    } finally {
      await Promise.all([
        rm(root, { recursive: true }),
        rm(left, { recursive: true }),
        rm(right, { recursive: true }),
        rm(shared, { recursive: true }),
      ])
    }
  })

  it('preserves nested // traversal across several volume boundaries', async () => {
    const a = await mkdtemp(join(tmpdir(), 'dagr-volume-a-'))
    const b = await mkdtemp(join(tmpdir(), 'dagr-volume-b-'))
    const c = await mkdtemp(join(tmpdir(), 'dagr-volume-c-'))
    await writeFiles(a, { 'b/dagr.mount.yaml': 'repo: b\n' })
    await writeFiles(b, { 'c/dagr.mount.yaml': 'repo: c\n' })
    await writeFiles(c, { 'pkg/dagr.index.js': PACKAGE() })
    const root = await repository({ 'a/dagr.mount.yaml': 'repo: a\n' }, ['a', 'b', 'c'])
    const calls: MaterializeCall[] = []

    try {
      assert.ok(await new RepositoryPackageLoader(
        root,
        materializer({ a, b, c }, calls),
      ).loadPackage('a//b//c//pkg'))
      assert.deepEqual(calls.map(call => call.id), ['a', 'b', 'c'])
      assert.deepEqual(calls.map(call => call.path), ['a', 'a//b', 'a//b//c'])
    } finally {
      await Promise.all([
        rm(root, { recursive: true }),
        rm(a, { recursive: true }),
        rm(b, { recursive: true }),
        rm(c, { recursive: true }),
      ])
    }
  })

  it('does not resolve or materialize unused mounts during discovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dagr-volume-lazy-'))
    await writeFiles(root, {
      'dagr.index.js': PACKAGE(),
      'unused/dagr.mount.yaml': 'repo: undefined-volume\n',
    })

    try {
      const packages = await new RepositoryPackageLoader(root).loadAllPackages()
      assert.deepEqual([...packages.keys()], ['.'])
    } finally {
      await rm(root, { recursive: true })
    }
  })

  it('reports an undefined traversed volume ID and its mount path', async () => {
    const root = await repository({
      'vendor/foo/dagr.mount.yaml': 'repo: github.com/acme/missing\n',
    }, [])

    try {
      await assert.rejects(
        new RepositoryPackageLoader(root).loadPackage('vendor/foo//pkg'),
        error => {
          assert.match(String(error), /github\.com\/acme\/missing/)
          assert.match(String(error), /\/\/vendor\/foo/)
          return true
        },
      )
    } finally {
      await rm(root, { recursive: true })
    }
  })

  it('reports materialization failures with the volume ID and mount path', async () => {
    const root = await repository({
      'vendor/foo/dagr.mount.yaml': 'repo: github.com/acme/foo\n',
    }, ['github.com/acme/foo'])

    try {
      await assert.rejects(
        new RepositoryPackageLoader(root, {
          materialize: async () => { throw new Error('builder exploded') },
        }).loadPackage('vendor/foo//pkg'),
        error => {
          assert.match(messages(error), /Failed to materialize volume "github\.com\/acme\/foo"/)
          assert.match(messages(error), /\/\/vendor\/foo/)
          assert.match(messages(error), /builder exploded/)
          return true
        },
      )
    } finally {
      await rm(root, { recursive: true })
    }
  })

  it('rejects the former index mount shape with migration guidance', async () => {
    const root = await repository({
      'vendor/foo/dagr.index.js': `export default {
        '/': { FROM: 'alpine', steps: [], IGNORE: [] }
      }\n`,
    }, [])

    try {
      await assert.rejects(
        new RepositoryPackageLoader(root).loadPackage('vendor/foo'),
        error => {
          assert.match(String(error), /former \{ "\/": mountImplementation \} shape is not supported/)
          assert.match(String(error), /dagr\.mount\.yaml/)
          assert.match(String(error), /root \.dagr\/volumes\.yaml/)
          return true
        },
      )
    } finally {
      await rm(root, { recursive: true })
    }
  })

  it('ignores identity and implementation policy from mounted repositories', async () => {
    const outer = await mkdtemp(join(tmpdir(), 'dagr-volume-policy-'))
    const shared = await mkdtemp(join(tmpdir(), 'dagr-volume-policy-shared-'))
    await writeFiles(outer, {
      '.dagr/config.js': 'export const identifyVolume = () => "evil"\n',
      '.dagr/volumes.yaml': volumes('evil'),
      'nested/dagr.mount.yaml': 'repo: shared\n',
    })
    await writeFiles(shared, { 'pkg/dagr.index.js': PACKAGE() })
    const root = await repository({
      'outer/dagr.mount.yaml': 'repo: outer\n',
    }, ['outer', 'shared'])
    const calls: MaterializeCall[] = []

    try {
      assert.ok(await new RepositoryPackageLoader(
        root,
        materializer({ outer, shared }, calls),
      ).loadPackage('outer//nested//pkg'))
      assert.deepEqual(calls.map(call => call.id), ['outer', 'shared'])
      assert.equal(calls[1]?.implementation.FROM, 'image:shared')
    } finally {
      await Promise.all([
        rm(root, { recursive: true }),
        rm(outer, { recursive: true }),
        rm(shared, { recursive: true }),
      ])
    }
  })

  it('allows dagr.index.js and dagr.mount.yaml at the same attachment point', async () => {
    const mounted = await mkdtemp(join(tmpdir(), 'dagr-volume-coexist-'))
    await writeFiles(mounted, { 'pkg/dagr.index.js': PACKAGE('mounted') })
    const root = await repository({
      'tool/dagr.index.js': PACKAGE('local'),
      'tool/dagr.mount.yaml': 'repo: tool\n',
      'tool/hidden/dagr.index.js': PACKAGE('hidden'),
    }, ['tool'])
    const calls: MaterializeCall[] = []
    const loader = new RepositoryPackageLoader(root, materializer({ tool: mounted }, calls))

    try {
      const local = await loader.loadPackage('tool')
      assert.equal(local?.definition['ci']?.['build']?.run({
        images: {}, host: { os: 'linux', arch: 'x64' },
      }).FROM, 'local')
      assert.equal(calls.length, 0)

      assert.ok(await loader.loadPackage('tool//pkg'))
      assert.equal(calls.length, 1)

      const discovered = await loader.loadAllPackages()
      assert.ok(discovered.has('tool'))
      assert.equal(discovered.has('tool/hidden'), false)
    } finally {
      await Promise.all([
        rm(root, { recursive: true }),
        rm(mounted, { recursive: true }),
      ])
    }
  })

  it('traverses a mount without evaluating a colocated index', async () => {
    const mounted = await mkdtemp(join(tmpdir(), 'dagr-volume-independent-'))
    await writeFiles(mounted, { 'pkg/dagr.index.js': PACKAGE('mounted') })
    const root = await repository({
      'tool/dagr.index.js': 'throw new Error("local index must not run")\n',
      'tool/dagr.mount.yaml': 'repo: tool\n',
    }, ['tool'])

    try {
      assert.ok(await new RepositoryPackageLoader(
        root,
        materializer({ tool: mounted }, []),
      ).loadPackage('tool//pkg'))
    } finally {
      await Promise.all([
        rm(root, { recursive: true }),
        rm(mounted, { recursive: true }),
      ])
    }
  })
})

function messages(error: unknown): string {
  const result: string[] = []
  for (let current = error; current instanceof Error; current = current.cause)
    result.push(current.message)
  return result.join('\n')
}
