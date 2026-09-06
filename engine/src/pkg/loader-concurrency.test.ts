import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { RepositoryPackageLoader, type VolumeMaterializer } from '#pkg/loader.js'

describe('RepositoryPackageLoader module linking', () => {
  it('loads concurrent package indexes that share nested mounted imports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dagr-loader-root-'))
    const stackRoot = await mkdtemp(join(tmpdir(), 'dagr-loader-stack-'))
    const diRoot = await mkdtemp(join(tmpdir(), 'dagr-loader-di-'))

    try {
      await mkdir(join(root, '.dagr'), { recursive: true })
      await mkdir(join(root, 'stack'), { recursive: true })
      await writeFile(join(root, '.dagr', 'config.js'), `
        export const identifyVolume = request => request.id
      `)
      await writeFile(join(root, '.dagr', 'volumes.yaml'), `
outer:
  FROM: outer
  steps: []
  IGNORE: []
inner:
  FROM: inner
  steps: []
  IGNORE: []
`)
      await writeFile(join(root, 'stack', 'dagr.mount.yaml'), 'id: outer\n')

      await mkdir(join(stackRoot, 'di'), { recursive: true })
      await writeFile(join(stackRoot, 'di', 'dagr.mount.yaml'), 'id: inner\n')
      await writeFile(join(stackRoot, 'dagr.stack.js'), `
        import { image } from '//di//dagr.di.js'
        export { image }
      `)
      await writeFile(join(diRoot, 'dagr.di.js'), `
        export const image = 'alpine:3.22'
      `)

      const declaration = `
        import { image } from '//stack//dagr.stack.js'
        export default {
          ci: {
            test: {
              deps: [],
              run: () => ({ FROM: image, steps: [], IGNORE: [] })
            }
          }
        }
      `
      const packageNames = ['a', 'b', 'c', 'd']
      for (const name of packageNames) {
        const dir = join(root, 'packages', name)
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, 'dagr.index.js'), declaration)
      }

      const roots: Record<string, string> = { outer: stackRoot, inner: diRoot }
      const materializer: VolumeMaterializer = {
        materialize: async id => ({ root: roots[id]! }),
      }
      const packages = await new RepositoryPackageLoader(root, materializer).loadAllPackages()
      assert.equal(packages.size, packageNames.length)

      for (const name of packageNames) {
        const run = packages.get(`packages/${name}`)?.definition['ci']?.['test']?.run({
          images: {},
          host: { os: 'linux', arch: 'x64' },
        })
        assert.equal(run?.FROM, 'alpine:3.22')
      }
    } finally {
      await Promise.all([
        rm(root, { recursive: true }),
        rm(stackRoot, { recursive: true }),
        rm(diRoot, { recursive: true }),
      ])
    }
  })
})
