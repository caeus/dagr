import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DockerVolumeMaterializer, validateSymlinks } from '#runner/volume-materializer.js'
import type { DockerfileRenderer } from '#runner/dockerfile-renderer.js'
import type { DockerImageBuilder } from '#runner/docker-builder.js'
import type { DockerImageCopier } from '#runner/docker-copier.js'
import type { DockerImageInspector } from '#runner/docker-inspector.js'

describe('DockerVolumeMaterializer', () => {
  it('builds the recipe and extracts the final WORKDIR contents', async () => {
    const volumeRoot = await mkdtemp(join(tmpdir(), 'dagr-mounts-'))
    const contextRoot = await mkdtemp(join(tmpdir(), 'dagr-context-'))
    const calls: Array<{ src: string; dest: string }> = []
    const renderer: DockerfileRenderer = { renderDockerfile: () => 'FROM tools\n' }
    const builder: DockerImageBuilder = {
      buildDockerImage: async (_content, tag, context, ignore) => {
        assert.equal(tag, `dagr-volume-${createHash('sha256').update('tools').digest('hex')}`)
        assert.equal(context, contextRoot)
        assert.deepEqual(ignore, ['node_modules'])
        return { tag, digest: 'sha256:tools' }
      },
    }
    const inspector: DockerImageInspector = {
      inspectImageWorkdir: async () => '/dagr',
    }
    const copier: DockerImageCopier = {
      copyFromImage: async (_imageTag, copies) => {
        calls.push(...copies)
      },
    }

    try {
      const materializer = new DockerVolumeMaterializer(
        renderer,
        builder,
        copier,
        inspector,
        volumeRoot,
        contextRoot,
      )
      const mounted = await materializer.materialize(
        'tools',
        { FROM: 'tools', steps: [], IGNORE: ['node_modules'] },
        'packages/tools',
      )

      assert.equal(calls.length, 1)
      assert.deepEqual(calls[0], { src: '/dagr/.', dest: mounted.root })
    } finally {
      await Promise.all([
        rm(volumeRoot, { recursive: true }),
        rm(contextRoot, { recursive: true }),
      ])
    }
  })

  it('rejects an unset or root final WORKDIR', async () => {
    const volumeRoot = await mkdtemp(join(tmpdir(), 'dagr-mounts-'))
    const contextRoot = await mkdtemp(join(tmpdir(), 'dagr-context-'))
    let copied = false
    const materializer = new DockerVolumeMaterializer(
      { renderDockerfile: () => 'FROM tools\n' },
      {
        buildDockerImage: async (_content, tag) => ({ tag, digest: 'sha256:tools' }),
      },
      {
        copyFromImage: async () => { copied = true },
      },
      { inspectImageWorkdir: async () => '/' },
      volumeRoot,
      contextRoot,
    )

    try {
      await assert.rejects(
        materializer.materialize(
          'tools',
          { FROM: 'tools', steps: [], IGNORE: [] },
          'packages/tools',
        ),
        /non-root final WORKDIR/,
      )
      assert.equal(copied, false)
    } finally {
      await Promise.all([
        rm(volumeRoot, { recursive: true }),
        rm(contextRoot, { recursive: true }),
      ])
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
