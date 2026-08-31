import type { PackageLoader } from '#pkg/loader.js'
import { ROOT_MARKER } from '#pkg/namespace.js'
import { Name, type HostPlatform } from '#pkg/schema.js'
import { runTarget, type TargetRunnerDeps } from '#runner/target-runner.js'

export class FQT {
  constructor(
    readonly pkg: string,
    readonly facet: string,
    readonly target: string,
  ) {}

  toString(): string {
    const pkg = this.pkg === '.' ? '' : this.pkg
    return `${ROOT_MARKER}${pkg}:${this.facet}:${this.target}`
  }

  toJSON(): string {
    return this.toString()
  }

  static parse(raw: string, context?: { pkg: string; facet?: string }): FQT {
    const parts = raw.split(':')
    if (parts.length === 3) {
      const pkg = parts[0]
      if (!pkg?.startsWith(ROOT_MARKER))
        throw new Error(`Fully qualified targets must start with ${ROOT_MARKER}: ${raw}`)
      return new FQT(
        pkg === ROOT_MARKER ? '.' : required(pkg.slice(ROOT_MARKER.length), raw),
        name(parts[1], raw),
        name(parts[2], raw),
      )
    }
    if (parts.length === 2) {
      if (!context?.pkg) throw new Error(`Package required when only facet:target is provided: ${raw}`)
      return new FQT(context.pkg, name(parts[0], raw), name(parts[1], raw))
    }
    if (parts.length === 1) {
      if (!context?.pkg) throw new Error(`Package required when only target is provided: ${raw}`)
      if (!context.facet) throw new Error(`Facet required when only target is provided: ${raw}`)
      return new FQT(context.pkg, context.facet, name(parts[0], raw))
    }
    throw new Error(`Invalid FQT: ${raw}`)
  }
}

function required(value: string | undefined, raw: string): string {
  if (!value) throw new Error(`Invalid FQT: ${raw}`)
  return value
}

function name(value: string | undefined, raw: string): string {
  const result = Name.safeParse(value)
  if (!result.success) throw new Error(`Invalid FQT: ${raw}`)
  return result.data
}

export interface TargetResult {
  readonly fqt: FQT
  readonly imageTag: string
  readonly imageDigest: string
  readonly export?: Readonly<Record<string, string>>
}

export type Runner = (fqt: FQT) => Promise<TargetResult>

export { type TargetRunnerDeps }

export function buildRunner(
  packageLoader: PackageLoader,
  deps: TargetRunnerDeps,
  host: HostPlatform,
): Runner {
  const memo = new Map<string, Promise<TargetResult>>()

  const run = (raw: string, trace: readonly string[] = []): Promise<TargetResult> => {
    if (trace.includes(raw))
      return Promise.reject(new Error(`Circular dependency: ${[...trace, raw].join(' -> ')}`))

    const cached = memo.get(raw)
    if (cached) return cached

    const promise = (async () => {
      const fqt = FQT.parse(raw)
      const loaded = await packageLoader.loadPackage(fqt.pkg)
      const target = loaded?.definition[fqt.facet]?.[fqt.target]
      if (!target) throw new Error(`Unknown target: ${raw}`)

      const nextTrace = [...trace, raw]
      const depResults = await Promise.all(
        target.deps.map(d => run(
          FQT.parse(d, { pkg: fqt.pkg, facet: fqt.facet }).toString(),
          nextTrace,
        ))
      )
      return runTarget(
        fqt,
        target,
        depResults,
        loaded.context,
        deps,
        host,
        source => packageLoader.resolveCopySource(fqt.pkg, source),
      )
    })()

    memo.set(raw, promise)
    return promise
  }

  return (fqt: FQT) => run(fqt.toString())
}
