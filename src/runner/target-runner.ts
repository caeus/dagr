import { Run, type HostPlatform, type TargetDef } from '#pkg/schema.js'
import type { ResolvedCopySource } from '#pkg/loader.js'
import type { Reporter } from '#report/reporter.js'
import type { BuildResult } from '#runner/docker-builder.js'
import type { FQT, TargetResult } from '#runner/index.js'

export interface TargetRunnerDeps {
  renderDockerfile(run: ReturnType<TargetDef['run']>): string
  buildDockerImage(
    content: string,
    tag: string,
    context: string,
    ignore: readonly string[],
    buildContexts?: Readonly<Record<string, string>>,
  ): Promise<BuildResult>
  readonly reporter: Reporter
}

export async function runTarget(
  fqt: FQT,
  target: TargetDef,
  depResults: TargetResult[],
  packageDir: string,
  deps: TargetRunnerDeps,
  host: HostPlatform,
  resolveCopySource: (source: string) => Promise<ResolvedCopySource>,
): Promise<TargetResult> {
  const tag = fqt.toString().replace(/:/g, '-').replace(/\//g, '_').replace(/^[^a-zA-Z0-9]+/, '')

  const images = Object.fromEntries(
    target.deps.map((dep, i) => [dep, depResults[i]!.imageTag])
  )

  const startedAt = Date.now()
  deps.reporter.targetStarted(fqt.toString())

  try {
    const parsed = Run.safeParse(target.run({ images, host }))
    if (!parsed.success) throw new Error(`Invalid run definition for ${fqt}: ${parsed.error.message}`)
    const runDef = parsed.data
    const resolved = await resolveMountedCopies(runDef, resolveCopySource)

    const dockerfileContent = deps.renderDockerfile(resolved.run)
    const { tag: imageTag, digest: imageDigest } = await deps.buildDockerImage(
      dockerfileContent,
      tag,
      packageDir,
      runDef.IGNORE,
      resolved.buildContexts,
    )

    deps.reporter.targetCompleted(fqt.toString(), Date.now() - startedAt)

    return runDef.EXPORT
      ? { fqt, imageTag, imageDigest, export: runDef.EXPORT }
      : { fqt, imageTag, imageDigest }
  } catch (error) {
    deps.reporter.targetFailed(fqt.toString(), Date.now() - startedAt)
    throw error
  }
}

async function resolveMountedCopies(
  run: Run,
  resolveCopySource: (source: string) => Promise<ResolvedCopySource>,
): Promise<{ readonly run: Run; readonly buildContexts: Readonly<Record<string, string>> }> {
  const steps: Run['steps'][number][] = []
  const buildContexts: Record<string, string> = {}
  const names = new Map<string, string>()

  for (const step of run.steps) {
    if (!('COPY' in step) || step.COPY.from || !step.COPY.src.includes('//')) {
      steps.push(step)
      continue
    }

    const source = await resolveCopySource(step.COPY.src)
    let from = names.get(source.context)
    if (!from) {
      from = `dagr_mount_${names.size}`
      names.set(source.context, from)
      buildContexts[from] = source.context
    }
    steps.push({ COPY: { from, src: source.src, dest: step.COPY.dest } })
  }

  return {
    run: { ...run, steps },
    buildContexts,
  }
}
