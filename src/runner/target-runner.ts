import { Run, type HostPlatform, type TargetDef } from '#pkg/schema.js'
import type { Reporter } from '#report/reporter.js'
import type { BuildResult } from '#runner/docker-builder.js'
import type { FQT, TargetResult } from '#runner/index.js'

export interface TargetRunnerDeps {
  renderDockerfile(run: ReturnType<TargetDef['run']>): string
  buildDockerImage(content: string, tag: string, context: string, ignore: readonly string[]): Promise<BuildResult>
  readonly reporter: Reporter
}

export async function runTarget(fqt: FQT, target: TargetDef, depResults: TargetResult[], packageDir: string, deps: TargetRunnerDeps, host: HostPlatform): Promise<TargetResult> {
  const tag = fqt.toString().replace(/#/g, '-').replace(/\//g, '_').replace(/^[^a-zA-Z0-9]+/, '')

  const images = Object.fromEntries(
    target.deps.map((dep, i) => [dep, depResults[i]!.imageTag])
  )

  const startedAt = Date.now()
  deps.reporter.targetStarted(fqt.toString())

  try {
    const parsed = Run.safeParse(target.run({ images, host }))
    if (!parsed.success) throw new Error(`Invalid run definition for ${fqt}: ${parsed.error.message}`)
    const runDef = parsed.data

    const dockerfileContent = deps.renderDockerfile(runDef)
    const { tag: imageTag, digest: imageDigest } = await deps.buildDockerImage(dockerfileContent, tag, packageDir, runDef.IGNORE)

    deps.reporter.targetCompleted(fqt.toString(), Date.now() - startedAt)

    return runDef.EXPORT
      ? { fqt, imageTag, imageDigest, export: runDef.EXPORT }
      : { fqt, imageTag, imageDigest }
  } catch (error) {
    deps.reporter.targetFailed(fqt.toString(), Date.now() - startedAt)
    throw error
  }
}
