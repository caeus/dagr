import type { PackageLoader } from '#pkg/loader.js'
import { ROOT_MARKER } from '#pkg/namespace.js'
import { SemanticPath, type HostPlatform, type Value } from '#pkg/schema.js'
import { runTarget, type TargetRunnerDeps } from '#runner/target-runner.js'

export class FQT {
  constructor(readonly pkg: string, readonly path: string) {
    if (!pkg.startsWith(ROOT_MARKER) || pkg.includes(':') ||
        pkg.slice(2).split('/').some(segment => segment === '.' || segment === '..'))
      throw new Error(`Invalid project: ${pkg}`)
    if (!SemanticPath.safeParse(path).success) throw new Error(`Invalid semantic path: ${path}`)
  }

  toString(): string { return `${this.pkg}:${this.path}` }
  toJSON(): string { return this.toString() }

  static parse(raw: string, context?: { pkg: string }): FQT {
    const parts = raw.split(':')
    if (parts.length === 1 && context)
      return new FQT(context.pkg, raw)
    if (parts.length === 2)
      return new FQT(parts[0]!, parts[1]!)
    throw new Error(`Expected /node/path or //project:/node/path: ${raw}`)
  }
}

export interface TargetResult {
  readonly fqt: FQT
  readonly value: Value
  readonly build?: Readonly<{
    imageTag: string
    imageDigest: string
    export?: Readonly<Record<string, string>>
  }>
}
export type Runner = (fqt: FQT) => Promise<TargetResult>
export { type TargetRunnerDeps }

export function buildRunner(packageLoader: PackageLoader, deps: TargetRunnerDeps, host: HostPlatform): Runner {
  const memo = new Map<string, Promise<TargetResult>>()
  const edges = new Map<string, readonly string[]>()

  // Check the shared graph, not just the current traversal stack: two concurrently
  // requested roots may otherwise deadlock by waiting on each other's memoized promise.
  function declareEdges(key: string, dependencies: readonly string[]): void {
    edges.set(key, dependencies)
    const visit = (current: string, trace: readonly string[]): void => {
      if (current === key) throw new Error(`Circular dependency: ${[...trace, current].join(' -> ')}`)
      if (trace.includes(current)) return
      for (const dep of edges.get(current) ?? []) visit(dep, [...trace, current])
    }
    for (const dep of dependencies) visit(dep, [key])
  }

  function run(fqt: FQT): Promise<TargetResult> {
    const key = fqt.toString()
    const existing = memo.get(key)
    if (existing) return existing
    const promise = (async () => {
      const packagePath = packageLogicalPath(fqt.pkg)
      const loaded = await packageLoader.loadPackage(packagePath)
      const target = loaded?.definition[fqt.path]
      if (!loaded || !target) throw new Error(`Unknown node: ${key}`)
      const refs = Object.values(target.deps).map(ref => FQT.parse(ref, { pkg: fqt.pkg }))
      declareEdges(key, refs.map(ref => ref.toString()))
      const values = await Promise.all(refs.map(run))
      return runTarget(fqt, target, values, loaded.context, deps, host, source => {
        if (!packageLoader.resolveCopySource)
          throw new Error(`Package loader cannot resolve mounted COPY source: ${source}`)
        return packageLoader.resolveCopySource(packagePath, source)
      })
    })()
    memo.set(key, promise)
    return promise
  }
  return run
}

export function canonicalPackageName(logicalPath: string): string {
  return logicalPath === '.' ? ROOT_MARKER : `${ROOT_MARKER}${logicalPath}`
}

export function packageLogicalPath(packageName: string): string {
  if (!packageName.startsWith(ROOT_MARKER))
    throw new Error(`Package names must start with ${ROOT_MARKER}: ${packageName}`)
  return packageName === ROOT_MARKER ? '.' : packageName.slice(ROOT_MARKER.length)
}

export function relativePackageName(basePkg: string, pkg: string): string | undefined {
  if (pkg === basePkg) return '.'
  const base = packageLogicalPath(basePkg)
  const path = packageLogicalPath(pkg)
  if (base === '.') return `./${path}`
  const prefix = base.endsWith('/') ? base : `${base}/`
  return path.startsWith(prefix) ? `./${path.slice(prefix.length)}` : undefined
}
