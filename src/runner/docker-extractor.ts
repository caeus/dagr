import { spawn } from 'node:child_process'
import { basename } from 'node:path'

const MOUNT = '/host-out'

export async function extractFromImage(imageTag: string, exportMap: Readonly<Record<string, string>>, destDir: string): Promise<void> {
  for (const [src, dest] of Object.entries(exportMap)) {
    await runCommand('docker', [
      'run', '--rm', '-v', `${destDir}:${MOUNT}`, imageTag, 'sh', '-c', copyScript(src, dest),
    ])
  }
}

// A trailing slash on the source means "the contents of"; a trailing slash on the destination
// means "inside this directory". Intent comes from the path syntax, so nothing here inspects
// the filesystem, and files and directories need no separate handling.
export function copyScript(src: string, dest: string): string {
  const contentsOf = src.endsWith('/')
  const intoDirectory = dest.endsWith('/')
  const srcPath = trimSlashes(src)
  const destPath = trimSlashes(dest)

  const atPackageRoot = destPath === '' || destPath === '.'

  // Only the replace form is dangerous at the package root: it would rm -rf the bind mount,
  // which is the whole repository for the root package. Merging into "./" deletes nothing, so
  // it stays allowed. Run's schema rejects this too; the guard is duplicated here because the
  // consequence is severe enough that it should not depend on validation living elsewhere.
  if (atPackageRoot && !intoDirectory)
    throw new Error(`EXPORT "${src}" -> "${dest}": cannot replace the package directory itself; use "./" to merge into it`)

  const destDir = atPackageRoot ? MOUNT : `${MOUNT}/${destPath}`

  if (contentsOf) return `mkdir -p "${destDir}" && cp -a "${srcPath}"/. "${destDir}"/`

  const target = intoDirectory ? `${destDir}/${basename(srcPath)}` : destDir
  return `mkdir -p "$(dirname "${target}")" && rm -rf "${target}" && cp -a "${srcPath}" "${target}"`
}

const trimSlashes = (path: string): string => path.replace(/\/+$/, '')

function runCommand(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: 'inherit' })
    proc.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`))
    })
    proc.on('error', reject)
  })
}
