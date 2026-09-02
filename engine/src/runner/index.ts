import type { PackageLoader, ResolvedCopySource } from '#pkg/loader.js'
import { ROOT_MARKER } from '#pkg/namespace.js'
import { Name, type HostPlatform } from '#pkg/schema.js'
import { runTarget, type TargetRunnerDeps } from '#runner/target-runner.js'

export class FQT {
  constructor(
    readonly pkg: string,
    readonly facet: string,
    readonly target: string,
  ) {
    if (!pkg.startsWith(ROOT_MARKER))
      throw new Error(`Package names must start with ${ROOT_MARKER}: ${pkg}`)
  }

  toString(): string {
    return `${this.pkg}:${this.facet}:${this.target}`
  }

  toJSON(): string {
    return this.toString()
  }

  static parse(raw: string, context?: { pkg: string; facet?: string }): FQT {
    const parts = raw.split(':')
    if (parts.length === 3)
      return new FQT(
        resolvePackagePart(parts[0] ?? '', raw, context),
        name(parts[1], raw),
        name(parts[2], raw),
      )
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

export interface Selector {
  readonly pkg: string
  readonly facet?: string
  readonly target?: string
}

function isPackageAnchor(part: string): boolean {
  return part === '.' || part.startsWith('./') || part.startsWith(ROOT_MARKER)
}

function contextPackage(context: { pkg: string } | undefined, raw: string): string {
  if (!context?.pkg) throw new Error(`Package required when the package is omitted: ${raw}`)
  return context.pkg
}

export function parseSelector(raw: string, context?: { pkg: string }): Selector {
  const parts = raw.split(':')

  if (parts.length === 1) {
    const only = parts[0]!
    if (isPackageAnchor(only)) return { pkg: resolvePackagePart(only, raw, context) }
    return { pkg: contextPackage(context, raw), facet: name(only, raw) }
  }

  if (parts.length === 2) {
    const first = parts[0]!
    if (isPackageAnchor(first))
      return { pkg: resolvePackagePart(first, raw, context), facet: name(parts[1], raw) }
    return {
      pkg: contextPackage(context, raw),
      facet: name(first, raw),
      target: name(parts[1], raw),
    }
  }

  const fqt = FQT.parse(raw, context)
  return { pkg: fqt.pkg, facet: fqt.facet, target: fqt.target }
}

function resolvePackagePart(pkg: string, raw: string, context?: { pkg: string }): string {
  if (pkg === '.' || pkg.startsWith('./')) {
    if (!context?.pkg)
      throw new Error(`Package required when a relative package is provided: ${raw}`)
    return resolveRelativePackage(context.pkg, pkg, raw)
  }
  if (!pkg.startsWith(ROOT_MARKER))
    throw new Error(`Fully qualified targets must start with ${ROOT_MARKER}: ${raw}`)
  if (pkg !== ROOT_MARKER) required(pkg.slice(ROOT_MARKER.length), raw)
  return pkg
}

// Inverse of resolveRelativePackage: keep both halves of the ./ convention together.
export function relativePackageName(basePkg: string, pkg: string): string | undefined {
  if (pkg === basePkg) return '.'

  const base = packageLogicalPath(basePkg)
  const path = packageLogicalPath(pkg)
  if (base === '.') return `./${path}`

  const prefix = base.endsWith('/') ? base : `${base}/`
  return path.startsWith(prefix) ? `./${path.slice(prefix.length)}` : undefined
}

function resolveRelativePackage(contextPkg: string, relative: string, raw: string): string {
  const rest = relative === '.' ? '' : relative.slice('./'.length)
  if (rest === '') return contextPkg
  if (rest.split('/').some(segment => !segment || segment === '.' || segment === '..'))
    throw new Error(`Invalid FQT: ${raw}`)

  const base = packageLogicalPath(contextPkg)
  if (base === '.') return canonicalPackageName(rest)
  return canonicalPackageName(base.endsWith('/') ? `${base}${rest}` : `${base}/${rest}`)
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
      const packagePath = packageLogicalPath(fqt.pkg)
      const loaded = await packageLoader.loadPackage(packagePath)
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
        source => resolveCopySource(packageLoader, packagePath, source),
      )
    })()

    memo.set(raw, promise)
    return promise
  }

  return (fqt: FQT) => run(fqt.toString())
}

export function canonicalPackageName(logicalPath: string): string {
  return logicalPath === '.' ? ROOT_MARKER : `${ROOT_MARKER}${logicalPath}`
}

export function packageLogicalPath(packageName: string): string {
  if (!packageName.startsWith(ROOT_MARKER))
    throw new Error(`Package names must start with ${ROOT_MARKER}: ${packageName}`)
  return packageName === ROOT_MARKER ? '.' : packageName.slice(ROOT_MARKER.length)
}

function resolveCopySource(
  loader: PackageLoader,
  packageLogicalPath: string,
  source: string,
): Promise<ResolvedCopySource> {
  const resolver = (loader as PackageLoader & Partial<{
    resolveCopySource(packageLogicalPath: string, source: string): Promise<ResolvedCopySource>
  }>).resolveCopySource
  if (!resolver)
    return Promise.reject(new Error(`Package loader cannot resolve mounted COPY source: ${source}`))
  return resolver.call(loader, packageLogicalPath, source)
}
