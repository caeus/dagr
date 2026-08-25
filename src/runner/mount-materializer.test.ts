import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createMountMaterializer, validateSymlinks } from '#runner/mount-materializer.js'
import type {
  DockerfileRenderer,
  DockerImageBuilder,
  DockerImageCopier,
  DockerImageInspector,
} from '#wire.js'

describe('createMountMaterializer', () => {
  it('builds the recipe and extracts the final WORKDIR contents', async () => {
    const mountRoot = await mkdtemp(join(tmpdir(), 'dagr-mounts-'))
    const calls: Array<{ src: string; dest: string }> = []
    const renderer: DockerfileRenderer = { renderDockerfile: () => 'FROM tools\n' }
    const builder: DockerImageBuilder = {
      buildDockerImage: async (_content, tag, context, ignore) => {
        assert.equal(tag, 'packages_tools-mount')
        assert.equal(context, join(mountRoot, '.context'))
        assert.deepEqual(ignore, ['node_modules'])
        return { tag, digest: 'sha256:tools' }
      },
    }
    const inspector: DockerImageInspector = {
      inspectImageWorkdir: async () => '/dagr',
    }
    const copier: DockerImageCopier = {
      copyFromImage: async (_imageTag, src, dest) => {
        calls.push({ src, dest })
        await mkdir(dest)
      },
    }

    try {
      const materializer = createMountMaterializer({
        renderer,
        builder,
        copier,
        inspector,
        mountRoot,
      })
      const mounted = await materializer.materialize(
        { FROM: 'tools', steps: [], IGNORE: ['node_modules'] },
        'packages/tools',
      )

      assert.equal(mounted.identity, 'sha256:tools:/dagr')
      assert.equal(calls.length, 1)
      assert.deepEqual(calls[0], { src: '/dagr', dest: mounted.root })
    } finally {
      await rm(mountRoot, { recursive: true })
    }
  })

  it('rejects an unset or root final WORKDIR', async () => {
    const mountRoot = await mkdtemp(join(tmpdir(), 'dagr-mounts-'))
    let copied = false
    const materializer = createMountMaterializer({
      renderer: { renderDockerfile: () => 'FROM tools\n' },
      builder: {
        buildDockerImage: async (_content, tag) => ({ tag, digest: 'sha256:tools' }),
      },
      inspector: { inspectImageWorkdir: async () => '/' },
      copier: {
        copyFromImage: async () => { copied = true },
      },
      mountRoot,
    })

    try {
      await assert.rejects(
        materializer.materialize(
          { FROM: 'tools', steps: [], IGNORE: [] },
          'packages/tools',
        ),
        /non-root final WORKDIR/,
      )
      assert.equal(copied, false)
    } finally {
      await rm(mountRoot, { recursive: true })
    }
  })
})

describe('validateSymlinks', () => {
  it('allows symlinks whose final target stays inside the mounted root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dagr-symlinks-'))
    try {
      await writeFile(join(root, 'target'), 'ok')
      await symlink('target', join(root, 'link'))
      await validateSymlinks(root)
    } finally {
      await rm(root, { recursive: true })
    }
  })

  it('rejects symlinks whose final target escapes the mounted root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dagr-symlinks-'))
    const root = join(parent, 'root')
    await mkdir(root)
    await writeFile(join(parent, 'outside'), 'nope')
    await symlink('../outside', join(root, 'link'))

    try {
      await assert.rejects(validateSymlinks(root), /symlink that escapes its root/)
    } finally {
      await rm(parent, { recursive: true })
    }
  })

  it('rejects broken symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dagr-symlinks-'))
    try {
      await symlink('missing', join(root, 'link'))
      await assert.rejects(validateSymlinks(root), /broken or cyclic symlink/)
    } finally {
      await rm(root, { recursive: true })
    }
  })
})
