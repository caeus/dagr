import type { HostPlatform, PackageDef } from '../pkg/schema.js'
import { runTarget, type TargetRunnerDeps } from './target-runner.js'

export class FQT {
  constructor(
    readonly pkg: string,
    readonly facet: string,
    readonly target: string,
  ) {}

  toString(): string {
    return `${this.pkg}#${this.facet}#${this.target}`
  }

  toJSON(): string {
    return this.toString()
  }

  static parse(raw: string, context?: { pkg: string; facet?: string }): FQT {
    const parts = raw.split('#')
    if (parts.length === 3) return new FQT(parts[0]!, parts[1]!, parts[2]!)
    if (parts.length === 2) {
      if (!context?.pkg) throw new Error(`Package required when only facet#target is provided: ${raw}`)
      return new FQT(context.pkg, parts[0]!, parts[1]!)
    }
    if (parts.length === 1) {
      if (!context?.pkg) throw new Error(`Package required when only target is provided: ${raw}`)
      if (!context.facet) throw new Error(`Facet required when only target is provided: ${raw}`)
      return new FQT(context.pkg, context.facet, parts[0]!)
    }
    throw new Error(`Invalid FQT: ${raw}`)
  }
}

export interface TargetResult {
  readonly fqt: FQT
  readonly imageTag: string
  readonly imageDigest: string
  readonly export?: Readonly<Record<string, string>>
}

export type Runner = (fqt: FQT) => Promise<TargetResult>

export { type TargetRunnerDeps }

export function buildRunner(root: string, packages: ReadonlyMap<string, PackageDef>, deps: TargetRunnerDeps, host: HostPlatform): Runner {
  const memo = new Map<string, Promise<TargetResult>>()

  const run = (raw: string, trace: readonly string[] = []): Promise<TargetResult> => {
    const cached = memo.get(raw)
    if (cached) return cached

    if (trace.includes(raw)) throw new Error(`Circular dependency: ${[...trace, raw].join(' -> ')}`)

    const fqt = FQT.parse(raw)
    if (!fqt.facet || !fqt.target) throw new Error(`Invalid FQT: ${raw}`)

    const target = packages.get(fqt.pkg)?.[fqt.facet]?.[fqt.target]
    if (!target) throw new Error(`Unknown target: ${raw}`)

    const nextTrace = [...trace, raw]
    const promise = Promise.all(
      target.deps.map(d => run(FQT.parse(d, { pkg: fqt.pkg, facet: fqt.facet }).toString(), nextTrace))
    ).then(depResults => runTarget(fqt, target, depResults, root, deps, host))

    memo.set(raw, promise)
    return promise
  }

  return (fqt: FQT) => run(fqt.toString())
}
