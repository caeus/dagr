import { mkdir, readdir, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { MaterializedMount, MountMaterializer } from '#pkg/loader.js'
import type { MountDef } from '#pkg/schema.js'
import type { DockerfileRenderer } from '#runner/dockerfile-renderer.js'
import type { DockerImageBuilder } from '#runner/docker-builder.js'
import type { DockerImageCopier } from '#runner/docker-copier.js'
import type { DockerImageInspector } from '#runner/docker-inspector.js'

export class DockerMountMaterializer implements MountMaterializer {
  private readonly extracted = new Map<string, Promise<string>>()

  constructor(
    private readonly renderer: DockerfileRenderer,
    private readonly builder: DockerImageBuilder,
    private readonly copier: DockerImageCopier,
    private readonly inspector: DockerImageInspector,
    private readonly mountRoot: string,
  ) {}

  async materialize(mount: MountDef, logicalPath: string): Promise<MaterializedMount> {
    const tag = mountTag(logicalPath)
    const dockerfile = this.renderer.renderDockerfile(mount)
    const emptyContext = join(this.mountRoot, '.context')
    await mkdir(emptyContext, { recursive: true })
    const image = await this.builder.buildDockerImage(dockerfile, tag, emptyContext, mount.IGNORE)
    const workdir = await this.inspector.inspectImageWorkdir(image.tag)
    if (workdir === '/')
      throw new Error(`Mount image must configure a non-root final WORKDIR: ${logicalPath}`)
    const identity = `${image.digest}:${workdir}`

    let root = this.extracted.get(identity)
    if (!root) {
      root = this.extractMount(image.tag, image.digest, workdir)
      this.extracted.set(identity, root)
    }

    return { root: await root, identity }
  }

  private async extractMount(
    imageTag: string,
    imageDigest: string,
    workdir: string,
  ): Promise<string> {
    const key = createHash('sha256').update(`${imageDigest}\0${workdir}`).digest('hex')
    const root = join(this.mountRoot, key)
    await mkdir(root, { recursive: true })
    await this.copier.copyFromImage(
      imageTag,
      [{ src: `${workdir.replace(/\/+$/, '')}/.`, dest: root }],
    )
    await validateSymlinks(root)
    return root
  }
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
