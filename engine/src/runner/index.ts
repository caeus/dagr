import { of as globOf } from '#pkg/glob.js'
import type { PackageDef, Dependency, Args } from '#pkg/schema.js'
import type { PackageLoader } from '#pkg/loader.js'
import { ROOT_MARKER } from '#pkg/namespace.js'
import { SemanticPath, type HostPlatform, type Value } from '#pkg/schema.js'
import { runTarget, type TargetRunnerDeps } from '#runner/target-runner.js'

export class FQT {
  constructor(readonly pkg: string, readonly path: string) {
    if (!pkg.startsWith(ROOT_MARKER) || pkg.includes(':') || pkg.includes('\\') ||
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
    if (parts.length === 2) {
      const project = parts[0]!
      if (project === '.' || project.startsWith('./')) {
        if (!context) throw new Error(`Project context required: ${raw}`)
        const rest = project === '.' ? '' : project.slice(2)
        if (rest === '') return new FQT(context.pkg, parts[1]!)
        if (rest.split('/').some(segment => !segment || segment === '.' || segment === '..'))
          throw new Error(`Invalid relative project: ${project}`)
        return new FQT(context.pkg.endsWith('/') ? context.pkg + rest : context.pkg + '/' + rest, parts[1]!)
      }
      return new FQT(project, parts[1]!)
    }
    throw new Error(`Expected /node/path or //project:/node/path: ${raw}`)
  }
}

export type ResolvedDependency = FQT | readonly FQT[]

export async function resolveDependencies(
  loader: PackageLoader,
  pkg: string,
  graph: PackageDef,
  deps: Readonly<Record<string, Dependency>>,
): Promise<Readonly<Record<string, ResolvedDependency>>> {
  async function select(pattern: string): Promise<readonly FQT[]> {
    if (!pattern.includes('*')) return [FQT.parse(pattern, { pkg })]
    const boundary = pattern.indexOf(':')
    const project = boundary < 0 ? pkg : pattern.slice(0, boundary)
    const path = boundary < 0 ? pattern : pattern.slice(boundary + 1)
    const definition = project === pkg ? graph : (await loader.loadPackage(packageLogicalPath(project)))?.definition
    if (!definition) throw new Error(`Unknown project: ${project}`)
    const match = globOf(path.slice(1))
    return Object.keys(definition).filter(key => match(key.slice(1))).sort().map(key => new FQT(project, key))
  }
  return Object.fromEntries(await Promise.all(Object.entries(deps).map(async ([name, dep]) => {
    if (typeof dep === 'string' && !dep.includes('*')) return [name, FQT.parse(dep, { pkg })] as const
    const refs = (await Promise.all((typeof dep === 'string' ? [dep] : dep).map(select))).flat()
    return [name, [...new Map(refs.map(ref => [ref.toString(), ref])).values()]] as const
  })))
}

export function dependencyRefs(deps: Readonly<Record<string, ResolvedDependency>>): FQT[] {
  return Object.values(deps).flatMap(dep => dep instanceof FQT ? [dep] : [...dep])
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
      const target = loaded && Object.hasOwn(loaded.definition, fqt.path) ? loaded.definition[fqt.path] : undefined
      if (!loaded || !target) throw new Error(`Unknown node: ${key}`)
      const resolved = await resolveDependencies(packageLoader, fqt.pkg, loaded.definition, target.deps)
      declareEdges(key, dependencyRefs(resolved).map(ref => ref.toString()))
      const args: Args = Object.freeze(Object.assign(Object.create(null), Object.fromEntries(
        await Promise.all(Object.entries(resolved).map(async ([id, dep]) => [
          id, dep instanceof FQT ? (await run(dep)).value :
            Object.freeze(Object.assign(Object.create(null), Object.fromEntries(await Promise.all(
              dep.map(async ref => [ref.pkg === fqt.pkg ? ref.path : ref.toString(), (await run(ref)).value])
            )))),
        ]))
      )))
      return runTarget(fqt, target, args, loaded.context, deps, host, source => {
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
