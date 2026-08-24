import { join } from 'node:path'
import { Run, type HostPlatform, type TargetDef } from '../pkg/schema.js'
import type { BuildResult } from './docker-builder.js'
import type { FQT, TargetResult } from './index.js'

export interface TargetRunnerDeps {
  renderDockerfile(run: ReturnType<TargetDef['run']>): string
  buildDockerImage(content: string, tag: string, context: string, ignore: readonly string[]): Promise<BuildResult>
}

export async function runTarget(fqt: FQT, target: TargetDef, depResults: TargetResult[], root: string, deps: TargetRunnerDeps, host: HostPlatform): Promise<TargetResult> {
  const packageDir = join(root, fqt.pkg)
  const tag = fqt.toString().replace(/#/g, '-').replace(/\//g, '_').replace(/^[^a-zA-Z0-9]+/, '')

  const images = Object.fromEntries(
    target.deps.map((dep, i) => [dep, depResults[i]!.imageTag])
  )

  const parsed = Run.safeParse(target.run({ images, host }))
  if (!parsed.success) throw new Error(`Invalid run definition for ${fqt}: ${parsed.error.message}`)
  const runDef = parsed.data

  const dockerfileContent = deps.renderDockerfile(runDef)
  const { tag: imageTag, digest: imageDigest } = await deps.buildDockerImage(dockerfileContent, tag, packageDir, runDef.IGNORE)

  return runDef.EXPORT
    ? { fqt, imageTag, imageDigest, export: runDef.EXPORT }
    : { fqt, imageTag, imageDigest }
}
