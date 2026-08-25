import { mkdir, rm } from 'node:fs/promises'
import { dirname, isAbsolute, posix, relative, resolve, sep } from 'node:path'
import { copyFromImage } from '#runner/docker-copier.js'
import type { ProcessRunner } from '#sys/process-runner.js'

export async function extractFromImage(
  imageTag: string,
  exportMap: Readonly<Record<string, string>>,
  destDir: string,
  processRunner: ProcessRunner,
): Promise<void> {
  for (const [src, dest] of Object.entries(exportMap)) {
    const contentsOf = src.endsWith('/')
    const intoDirectory = dest.endsWith('/')
    const srcPath = trimSlashes(src)
    const destPath = trimSlashes(dest)
    const atPackageRoot = destPath === '' || destPath === '.'

    if (atPackageRoot && !intoDirectory)
      throw new Error(`EXPORT "${src}" -> "${dest}": cannot replace the package directory itself; use "./" to merge into it`)

    if (contentsOf) {
      const target = resolveInside(destDir, destPath)
      await mkdir(target, { recursive: true })
      await copyFromImage(imageTag, [{ src: `${srcPath}/.`, dest: target }], processRunner)
      continue
    }

    const sourceName = posix.basename(srcPath)
    if (intoDirectory && (sourceName === '.' || sourceName === '..'))
      throw new Error(`EXPORT "${src}" -> "${dest}": source has no exportable basename`)

    const target = resolveInside(
      destDir,
      intoDirectory ? `${destPath}/${sourceName}` : destPath,
    )
    await mkdir(dirname(target), { recursive: true })
    await rm(target, { recursive: true, force: true })
    await copyFromImage(imageTag, [{ src: srcPath, dest: target }], processRunner)
  }
}

function resolveInside(root: string, path: string): string {
  const target = resolve(root, path)
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`EXPORT destination escapes its package directory: ${path}`)
  return target
}

const trimSlashes = (path: string): string => path.replace(/\/+$/, '')
