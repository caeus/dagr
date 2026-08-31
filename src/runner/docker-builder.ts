import { writeFile, readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProcessRunner } from '#sys/process-runner.js'

export interface BuildResult {
  readonly tag: string
  readonly digest: string
}

export interface DockerImageBuilder {
  buildDockerImage(
    content: string,
    tag: string,
    context: string,
    ignore: readonly string[],
    buildContexts?: Readonly<Record<string, string>>,
  ): Promise<BuildResult>
}

export async function buildDockerImage(
  dockerfileContent: string,
  tag: string,
  contextPath: string,
  ignore: readonly string[],
  processRunner: ProcessRunner,
  buildContexts: Readonly<Record<string, string>> = {},
): Promise<BuildResult> {
  const base = join(tmpdir(), `dagr-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const dockerfilePath = `${base}.Dockerfile`
  const dockerignorePath = `${dockerfilePath}.dockerignore`
  const iidfilePath = `${base}.iid`

  await Promise.all([
    writeFile(dockerfilePath, dockerfileContent, 'utf-8'),
    writeFile(dockerignorePath, ignore.map(l => `${l}\n`).join(''), 'utf-8'),
  ])
  try {
    await processRunner.run(
      'docker',
      [
        'buildx', 'build', '--progress=plain', '--load', '-t', tag,
        ...Object.entries(buildContexts).flatMap(([name, path]) => [
          '--build-context', `${name}=${path}`,
        ]),
        '--iidfile', iidfilePath, '-f', dockerfilePath, contextPath,
      ],
      `image.build ${tag}`,
    )
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
