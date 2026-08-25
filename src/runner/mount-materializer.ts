import { mkdir, readdir, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { MountMaterializer } from '#pkg/loader.js'
import type { DockerfileRenderer, DockerImageBuilder, DockerImageCopier, DockerImageInspector } from '#wire.js'

export interface MountMaterializerDeps {
  readonly renderer: DockerfileRenderer
  readonly builder: DockerImageBuilder
  readonly copier: DockerImageCopier
  readonly inspector: DockerImageInspector
  readonly mountRoot: string
}

export function createMountMaterializer(deps: MountMaterializerDeps): MountMaterializer {
  const extracted = new Map<string, Promise<string>>()

  return {
    materialize: async (mount, logicalPath) => {
      const tag = mountTag(logicalPath)
      const dockerfile = deps.renderer.renderDockerfile(mount)
      const emptyContext = join(deps.mountRoot, '.context')
      await mkdir(emptyContext, { recursive: true })
      const image = await deps.builder.buildDockerImage(dockerfile, tag, emptyContext, mount.IGNORE)
      const workdir = await deps.inspector.inspectImageWorkdir(image.tag)
      if (workdir === '/')
        throw new Error(`Mount image must configure a non-root final WORKDIR: ${logicalPath}`)
      const identity = `${image.digest}:${workdir}`

      let root = extracted.get(identity)
      if (!root) {
        root = extractMount(image.tag, image.digest, workdir, deps)
        extracted.set(identity, root)
      }

      return { root: await root, identity }
    },
  }
}

async function extractMount(
  imageTag: string,
  imageDigest: string,
  workdir: string,
  deps: MountMaterializerDeps,
): Promise<string> {
  const key = createHash('sha256').update(`${imageDigest}\0${workdir}`).digest('hex')
  const root = join(deps.mountRoot, key)
  await deps.copier.copyFromImage(imageTag, workdir, root)
  await validateSymlinks(root)
  return root
}

export async function validateSymlinks(root: string): Promise<void> {
  const canonicalRoot = await realpath(root)
  await walk(canonicalRoot)

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    await Promise.all(entries.map(async (entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return walk(path)
      if (!entry.isSymbolicLink()) return

      let target: string
      try {
        target = await realpath(path)
      } catch (error) {
        throw new Error(`Mounted tree contains a broken or cyclic symlink: ${path}`, { cause: error })
      }

      const rel = relative(canonicalRoot, target)
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        throw new Error(`Mounted tree contains a symlink that escapes its root: ${path}`)
    }))
  }
}

function mountTag(logicalPath: string): string {
  const base = logicalPath
    .replace(/[#/\\]+/g, '_')
    .replace(/^[^a-zA-Z0-9]+/, '') || 'root'
  return `${base}-mount`
}
