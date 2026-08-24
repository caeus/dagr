import { writeFile, readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

export interface BuildResult {
  readonly tag: string
  readonly digest: string
}

export async function buildDockerImage(dockerfileContent: string, tag: string, contextPath: string, ignore: readonly string[]): Promise<BuildResult> {
  const base = join(tmpdir(), `dagr-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const dockerfilePath = `${base}.Dockerfile`
  const dockerignorePath = `${dockerfilePath}.dockerignore`
  const iidfilePath = `${base}.iid`

  await Promise.all([
    writeFile(dockerfilePath, dockerfileContent, 'utf-8'),
    writeFile(dockerignorePath, ignore.map(l => `${l}\n`).join(''), 'utf-8'),
  ])
  try {
    await runCommand('docker', ['buildx', 'build', '--load', '-t', tag, '--iidfile', iidfilePath, '-f', dockerfilePath, contextPath])
    const digest = (await readFile(iidfilePath, 'utf-8')).trim()
    return { tag, digest }
  } finally {
    await Promise.all([
      unlink(dockerfilePath).catch(() => undefined),
      unlink(dockerignorePath).catch(() => undefined),
      unlink(iidfilePath).catch(() => undefined),
    ])
  }
}

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
