import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { RepositoryPackageLoader, type VolumeMaterializer } from '#pkg/loader.js'

const PACKAGE = `
  export default {
    ci: {
      build: {
        deps: [],
        run: () => ({ FROM: 'alpine', steps: [], IGNORE: [] })
      }
    }
  }
`

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dagr-copy-source-'))
  await mkdir(join(root, 'packages/app/tools'), { recursive: true })
  await mkdir(join(root, '.dagr'), { recursive: true })
  await writeFile(join(root, 'packages/app/dagr.index.js'), PACKAGE)
  await writeFile(join(root, 'packages/app/tools/dagr.mount.yaml'), 'id: tools\n')
  await writeFile(join(root, '.dagr/config.js'), 'export const identifyVolume = request => request.id\n')
  await writeFile(join(root, '.dagr/volumes.yaml'), `
tools: &volume
  FROM: tools
  steps: []
  IGNORE: []
deps: *volume
`)
  return root
}

describe('RepositoryPackageLoader.resolveCopySource', () => {
  it('resolves a mount boundary relative to the target package', async () => {
    const root = await repository()
    const mountedRoot = await mkdtemp(join(tmpdir(), 'dagr-copy-mount-'))
    const calls: string[] = []
    const materializer: VolumeMaterializer = {
      materialize: async (_id, _implementation, logicalPath) => {
        calls.push(logicalPath)
        return { root: mountedRoot }
      },
    }

    try {
      const loader = new RepositoryPackageLoader(root, materializer)
      const resolved = await loader.resolveCopySource('packages/app', 'tools//include/a.h')

      assert.deepEqual(resolved, { context: mountedRoot, src: 'include/a.h' })
      assert.deepEqual(calls, ['packages/app/tools'])
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(mountedRoot, { recursive: true, force: true }),
      ])
    }
  })

  it('can cross nested mounted roots', async () => {
    const root = await repository()
    const firstRoot = await mkdtemp(join(tmpdir(), 'dagr-copy-mount-'))
    const secondRoot = await mkdtemp(join(tmpdir(), 'dagr-copy-mount-'))
    await mkdir(join(firstRoot, 'deps'), { recursive: true })
    await writeFile(join(firstRoot, 'deps/dagr.mount.yaml'), 'id: deps\n')

    const materializer: VolumeMaterializer = {
      materialize: async (_id, _implementation, logicalPath) => {
        if (logicalPath === 'packages/app/tools')
          return { root: firstRoot }
        if (logicalPath === 'packages/app/tools//deps')
          return { root: secondRoot }
        throw new Error(`Unexpected mount: ${logicalPath}`)
      },
    }

    try {
      const loader = new RepositoryPackageLoader(root, materializer)
      const resolved = await loader.resolveCopySource('packages/app', 'tools//deps//c.txt')

      assert.deepEqual(resolved, { context: secondRoot, src: 'c.txt' })
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(firstRoot, { recursive: true, force: true }),
        rm(secondRoot, { recursive: true, force: true }),
      ])
    }
  })

  it('requires each // prefix to resolve to a mount', async () => {
    const root = await repository()
    await mkdir(join(root, 'packages/app/plain'), { recursive: true })
    await writeFile(join(root, 'packages/app/plain/dagr.index.js'), PACKAGE)

    try {
      const loader = new RepositoryPackageLoader(root)
      await assert.rejects(
        loader.resolveCopySource('packages/app', 'plain//c.txt'),
        /crosses a non-mount path/,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
