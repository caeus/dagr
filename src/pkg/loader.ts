import vm from 'node:vm'
import { readdir, readFile, realpath } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { parse as parseYaml } from 'yaml'
import { BUILTIN_PREFIX, createBuiltinModules } from '#pkg/builtins.js'
import { ROOT_MARKER } from '#pkg/namespace.js'
import { createSandboxContext } from '#pkg/sandbox.js'
import { IndexDef, type MountDef, type MountIndex, type PackageDef } from '#pkg/schema.js'

const PACKAGE_FILE = 'dagr.index.js'
const IMPORT_FILE = /^dagr\..+\.(?:js|json|yaml|toml)$/

export interface PackageLoader {
  loadPackage(logicalPath: string): Promise<LoadedPackage | undefined>
  loadAllPackages(): Promise<ReadonlyMap<string, LoadedPackage>>
}

export interface LoadedPackage {
  readonly definition: PackageDef
  readonly context: string
}

export interface MaterializedMount {
  readonly root: string
  readonly identity: string
}

export interface MountMaterializer {
  materialize(
    mount: MountDef,
    logicalPath: string,
  ): Promise<MaterializedMount>
}

interface MountTrace {
  readonly identity: string
  readonly logicalPath: string
}

interface ResolvedImport {
  readonly path: string
  readonly context: LoadContext
}

interface LoadContext {
  readonly root: string
  readonly logicalRoot: string
  readonly trace: readonly MountTrace[]
  readonly vmContext: vm.Context
  readonly builtins: ReadonlyMap<string, vm.Module>
  readonly cache: Map<string, vm.Module>
  readonly resolveImport: (specifier: string, context: LoadContext) => Promise<ResolvedImport>
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value
  if (seen.has(value as object)) return value
  seen.add(value as object)
  Object.freeze(value)
  for (const v of Object.values(value as object)) deepFreeze(v, seen)
  return value
}

function isOutside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

function parseData(path: string, source: string): unknown {
  switch (extname(path)) {
    case '.json': return JSON.parse(source)
    case '.yaml': return parseYaml(source)
    case '.toml': return parseToml(source)
    default: throw new Error(`Unsupported Dagr data file: ${path}`)
  }
}

function packageLocation(logicalPath: string): string {
  const boundary = logicalPath.lastIndexOf(ROOT_MARKER)
  const path = boundary === -1
    ? logicalPath
    : logicalPath.slice(boundary + ROOT_MARKER.length)
  return path === '' || path === '.' ? ROOT_MARKER : `${ROOT_MARKER}${path}`
}

async function link(specifier: string, ctx: LoadContext): Promise<vm.Module> {
  const builtin = ctx.builtins.get(specifier)
  if (builtin) return builtin
  if (specifier.startsWith(BUILTIN_PREFIX))
    throw new Error(`Unknown Dagr built-in module: ${specifier}`)

  const resolved = await ctx.resolveImport(specifier, ctx)
  const { path } = resolved
  const key = `${resolved.context.logicalRoot}\0${path}`
  const cached = ctx.cache.get(key)
  if (cached) return cached

  if (extname(path) !== '.js') {
    const value = deepFreeze(parseData(path, await readFile(path, 'utf-8')))
    const mod = new vm.SyntheticModule(
      ['default'],
      function () { this.setExport('default', value) },
      { context: resolved.context.vmContext, identifier: path }
    )
    ctx.cache.set(key, mod)
    return mod
  }

  const code = await readFile(path, 'utf-8')
  const mod = new vm.SourceTextModule(code, {
    context: resolved.context.vmContext,
    identifier: path,
  })
  ctx.cache.set(key, mod)
  await mod.link((nestedSpecifier) => link(nestedSpecifier, resolved.context))
  return mod
}

async function loadIndex(
  filePath: string,
  logicalPath: string,
  ctx: LoadContext,
): Promise<IndexDef | null> {
  const path = await realpath(filePath)
  if (isOutside(ctx.root, path))
    throw new Error(`Dagr index must stay inside its source root, got: ${filePath}`)

  const code = await readFile(path, 'utf-8')
  const dagr = Object.freeze(Object.assign(Object.create(null), {
    location: packageLocation(logicalPath),
  }))
  const mod = new vm.SourceTextModule(code, {
    context: ctx.vmContext,
    identifier: path,
    initializeImportMeta(meta) {
      Object.defineProperty(meta, 'dagr', {
        value: dagr,
        enumerable: true,
      })
    },
  })
  await mod.link((specifier) => link(specifier, ctx))
  await mod.evaluate()
  const defaultExport = (mod.namespace as Record<string, unknown>)['default']
  const result = IndexDef.safeParse(defaultExport)
  return result.success ? deepFreeze(result.data) : null
}

function isMountIndex(index: IndexDef): index is MountIndex {
  return Object.hasOwn(index, '/')
}

export class RepositoryPackageLoader implements PackageLoader {
  private readonly canonicalRoot: Promise<string>
  private readonly vmContext = createSandboxContext()
  private readonly builtins = createBuiltinModules(this.vmContext)
  private readonly moduleCache = new Map<string, vm.Module>()
  private readonly indexCache = new Map<string, Promise<IndexDef | null>>()
  private readonly packageCache = new Map<string, Promise<LoadedPackage | undefined>>()
  private readonly mountCache = new Map<string, Promise<MaterializedMount>>()
  private allPackages?: Promise<ReadonlyMap<string, LoadedPackage>>

  constructor(
    root: string,
    private readonly mountMaterializer?: MountMaterializer,
  ) {
    this.canonicalRoot = realpath(root)
  }

  loadPackage(logicalPath: string): Promise<LoadedPackage | undefined> {
    validateLogicalPath(logicalPath)
    let loaded = this.packageCache.get(logicalPath)
    if (!loaded) {
      loaded = this.resolvePackage(logicalPath)
      this.packageCache.set(logicalPath, loaded)
    }
    return loaded
  }

  loadAllPackages(): Promise<ReadonlyMap<string, LoadedPackage>> {
    if (!this.allPackages) this.allPackages = this.scanAllPackages()
    return this.allPackages
  }

  private context(
    root: string,
    logicalRoot: string,
    trace: readonly MountTrace[],
  ): LoadContext {
    return {
      root,
      logicalRoot,
      trace,
      vmContext: this.vmContext,
      builtins: this.builtins,
      cache: this.moduleCache,
      resolveImport: (specifier, context) => this.resolveImport(specifier, context),
    }
  }

  private async indexAt(
    dir: string,
    packageLogicalPath: string,
    sourceRoot: string,
    logicalRoot: string,
    trace: readonly MountTrace[],
  ): Promise<IndexDef | null> {
    const file = resolve(dir, PACKAGE_FILE)
    const key = `${packageLogicalPath}\0${logicalRoot}\0${sourceRoot}\0${file}`
    let index = this.indexCache.get(key)
    if (!index) {
      index = loadIndex(
      file,
      packageLogicalPath,
      this.context(sourceRoot, logicalRoot, trace),
    ).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
        throw error
      })
      this.indexCache.set(key, index)
    }
    return index
  }

  private async resolvePackage(logicalPath: string): Promise<LoadedPackage | undefined> {
    let sourceRoot = await this.canonicalRoot
    let logicalRoot = '.'
    let trace: readonly MountTrace[] = []
    const parts = logicalPath === '.' ? ['.'] : logicalPath.split('//')
    let declarationPath = ''

    for (let i = 0; i < parts.length; i++) {
      const relativePath = parts[i]!
      declarationPath = i === 0
        ? relativePath
        : `${declarationPath}//${relativePath}`
      const dir = relativePath === '.' || relativePath === ''
        ? sourceRoot
        : resolve(sourceRoot, relativePath)
      const index = await this.indexAt(dir, declarationPath, sourceRoot, logicalRoot, trace)

      if (i === parts.length - 1) {
        if (!index || isMountIndex(index)) return undefined
        return Object.freeze({ definition: index, context: dir })
      }
      if (!index || !isMountIndex(index)) return undefined

      const mounted = await this.materialize(index['/'], declarationPath, trace)
      sourceRoot = await realpath(mounted.root)
      logicalRoot = mountBoundary(declarationPath)
      trace = mounted.trace
    }
    return undefined
  }

  private async resolveImport(specifier: string, ctx: LoadContext): Promise<ResolvedImport> {
    if (!specifier.startsWith(ROOT_MARKER))
      throw new Error(`Dagr imports must start with ${ROOT_MARKER}, got: ${specifier}`)

    const parts = specifier.slice(ROOT_MARKER.length).split(ROOT_MARKER)
    let sourceRoot = ctx.root
    let logicalRoot = ctx.logicalRoot
    let trace = ctx.trace

    for (const mountPath of parts.slice(0, -1)) {
      validateRelativeImportPath(mountPath, specifier)
      const declarationDir = mountPath === ''
        ? sourceRoot
        : resolve(sourceRoot, mountPath)
      const declarationPath = joinSourceLogical(logicalRoot, mountPath)
      const index = await this.indexAt(
        declarationDir,
        declarationPath,
        sourceRoot,
        logicalRoot,
        trace,
      )
      if (!index || !isMountIndex(index))
        throw new Error(`Dagr import crosses a non-mount path: ${specifier}`)

      const mounted = await this.materialize(index['/'], declarationPath, trace)
      sourceRoot = await realpath(mounted.root)
      logicalRoot = mountBoundary(declarationPath)
      trace = mounted.trace
    }

    const filePath = parts.at(-1)!
    validateRelativeImportPath(filePath, specifier)
    const unresolved = resolve(sourceRoot, filePath)
    if (isOutside(sourceRoot, unresolved))
      throw new Error(`Dagr imports must stay inside their source root, got: ${specifier}`)
    if (!IMPORT_FILE.test(basename(unresolved)))
      throw new Error(
        `Dagr imports must target dagr.*.js, dagr.*.json, dagr.*.yaml, or dagr.*.toml, got: ${specifier}`
      )

    const path = await realpath(unresolved)
    if (isOutside(sourceRoot, path))
      throw new Error(`Dagr imports must stay inside their source root, got: ${specifier}`)
    return { path, context: this.context(sourceRoot, logicalRoot, trace) }
  }

  private async materialize(
    mount: MountDef,
    logicalPath: string,
    trace: readonly MountTrace[],
  ): Promise<{ readonly root: string; readonly trace: readonly MountTrace[] }> {
    if (!this.mountMaterializer)
      throw new Error(`Cannot load mount at ${logicalPath}: no mount materializer configured`)

    let materialized = this.mountCache.get(logicalPath)
    if (!materialized) {
      materialized = this.mountMaterializer.materialize(mount, logicalPath)
      this.mountCache.set(logicalPath, materialized)
    }
    const mounted = await materialized
    if (trace.some(entry => entry.identity === mounted.identity))
      throw new Error(
        `Circular mount: ${[...trace.map(entry => entry.logicalPath), logicalPath].join(' -> ')}`,
      )
    return {
      root: mounted.root,
      trace: [...trace, { identity: mounted.identity, logicalPath }],
    }
  }

  private async scanAllPackages(): Promise<ReadonlyMap<string, LoadedPackage>> {
    const root = await this.canonicalRoot
    const packages = new Map<string, LoadedPackage>()
    await this.scanRepository(root, '.', root, '.', packages, [])
    return Object.freeze(packages)
  }

  private async scanRepository(
    root: string,
    logicalRoot: string,
    sourceRoot: string,
    sourceLogicalRoot: string,
    acc: Map<string, LoadedPackage>,
    trace: readonly MountTrace[],
  ): Promise<void> {
    const index = await this.indexAt(root, logicalRoot, sourceRoot, sourceLogicalRoot, trace)
    if (index && isMountIndex(index)) {
      const mounted = await this.materialize(index['/'], logicalRoot, trace)
      const mountedRoot = await realpath(mounted.root)
      await this.scanRepository(
        mountedRoot,
        mountBoundary(logicalRoot),
        mountedRoot,
        mountBoundary(logicalRoot),
        acc,
        mounted.trace,
      )
      return
    }
    if (index) this.remember(logicalRoot, index, root, acc)

    const packages = resolve(root, 'packages')
    const entries = await readDirectories(packages)
    await Promise.all(entries.map(entry => this.walk(
      resolve(packages, entry),
      logicalRoot === '.'
        ? joinLogical('packages', entry)
        : joinLogical(logicalRoot, 'packages', entry),
      sourceRoot,
      sourceLogicalRoot,
      acc,
      trace,
    )))
  }

  private async walk(
    dir: string,
    logicalPath: string,
    sourceRoot: string,
    sourceLogicalRoot: string,
    acc: Map<string, LoadedPackage>,
    trace: readonly MountTrace[],
  ): Promise<void> {
    const index = await this.indexAt(dir, logicalPath, sourceRoot, sourceLogicalRoot, trace)
    if (index && isMountIndex(index)) {
      const mounted = await this.materialize(index['/'], logicalPath, trace)
      const mountedRoot = await realpath(mounted.root)
      await this.walk(
        mountedRoot,
        mountBoundary(logicalPath),
        mountedRoot,
        mountBoundary(logicalPath),
        acc,
        mounted.trace,
      )
      return
    }
    if (index) {
      this.remember(logicalPath, index, dir, acc)
      return
    }

    const entries = await readDirectories(dir)
    await Promise.all(entries.map(entry => this.walk(
      resolve(dir, entry),
      joinLogical(logicalPath, entry),
      sourceRoot,
      sourceLogicalRoot,
      acc,
      trace,
    )))
  }

  private remember(
    logicalPath: string,
    definition: PackageDef,
    context: string,
    acc: Map<string, LoadedPackage>,
  ): void {
    const loaded = Object.freeze({ definition, context })
    acc.set(logicalPath, loaded)
    this.packageCache.set(logicalPath, Promise.resolve(loaded))
  }
}

async function readDirectories(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return []
    throw error
  })
  return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
}

function validateLogicalPath(logicalPath: string): void {
  if (!logicalPath || isAbsolute(logicalPath) || logicalPath.includes('\\') || logicalPath.includes(':'))
    throw new Error(`Invalid package path: ${logicalPath}`)
  for (const part of logicalPath.split('//')) {
    if (part === '' || part === '.') continue
    if (part.split('/').some(segment => !segment || segment === '.' || segment === '..'))
      throw new Error(`Invalid package path: ${logicalPath}`)
  }
}

function validateRelativeImportPath(path: string, specifier: string): void {
  if (path.includes('\\') || isAbsolute(path))
    throw new Error(`Invalid Dagr import: ${specifier}`)
  if (path && path.split('/').some(segment => !segment || segment === '.' || segment === '..'))
    throw new Error(`Invalid Dagr import: ${specifier}`)
}

function joinSourceLogical(root: string, path: string): string {
  if (!path) return root
  if (root === '.') return path
  return root.endsWith('/') ? `${root}${path}` : `${root}/${path}`
}

function joinLogical(parent: string, ...children: readonly string[]): string {
  return [parent, ...children].reduce(
    (path, child) => path.endsWith('/') ? `${path}${child}` : `${path}/${child}`,
  )
}

function mountBoundary(logicalPath: string): string {
  return `${logicalPath}//`
}
