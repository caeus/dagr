import vm from 'node:vm'
import { readdir, readFile, realpath } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { parse as parseYaml } from 'yaml'
import { BUILTIN_PREFIX, createBuiltinModules } from '#pkg/builtins.js'
import { ROOT_MARKER } from '#pkg/namespace.js'
import { createSandboxContext } from '#pkg/sandbox.js'
import {
  ImageRecipe,
  IndexDef,
  type MountId,
  type MountImpl,
  type MountIndex,
  type MountResolver,
  type PackageDef,
} from '#pkg/schema.js'

const PACKAGE_FILE = 'dagr.index.js'
const CONFIG_FILE = '.dagr/config.js'
const IMPORT_FILE = /^dagr\..+\.(?:js|json|yaml|toml)$/
const DISCOVERY_EXCLUDED_DIRECTORIES = new Set(['.git'])

export interface PackageLoader {
  loadPackage(logicalPath: string): Promise<LoadedPackage | undefined>
  loadAllPackages(): Promise<ReadonlyMap<string, LoadedPackage>>
  resolveCopySource?(packageLogicalPath: string, source: string): Promise<ResolvedCopySource>
}

export interface LoadedPackage {
  readonly definition: PackageDef
  readonly context: string
}

export interface ResolvedCopySource {
  readonly context: string
  readonly src: string
}

export interface MaterializedMount {
  readonly root: string
}

export interface MountMaterializer {
  materialize(
    mount: MountImpl,
    id: MountId,
  ): Promise<MaterializedMount>
}

interface MountTrace {
  readonly id: MountId
  readonly logicalPath: string
}

interface RootConfig {
  readonly mount?: MountResolver
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
  readonly moduleContexts: WeakMap<vm.Module, LoadContext>
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
    ctx.moduleContexts.set(mod, resolved.context)
    return mod
  }

  const code = await readFile(path, 'utf-8')
  const mod = new vm.SourceTextModule(code, {
    context: resolved.context.vmContext,
    identifier: path,
  })
  ctx.cache.set(key, mod)
  ctx.moduleContexts.set(mod, resolved.context)
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
  ctx.moduleContexts.set(mod, ctx)
  await mod.link((specifier, referencingModule) => link(
    specifier,
    ctx.moduleContexts.get(referencingModule) ?? ctx,
  ))
  await mod.evaluate()
  const defaultExport = (mod.namespace as Record<string, unknown>)['default']
  const result = IndexDef.safeParse(defaultExport)
  if (result.success) return deepFreeze(result.data)
  if (
    defaultExport !== null &&
    typeof defaultExport === 'object' &&
    Object.hasOwn(defaultExport, '/')
  ) throw new Error(
    `Invalid mount declaration at ${logicalAddress(logicalPath)}: ${result.error.message}`,
  )
  return null
}

async function loadRootConfig(root: string, context: vm.Context): Promise<RootConfig> {
  let path: string
  try {
    path = await realpath(resolve(root, CONFIG_FILE))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze({})
    throw error
  }
  if (isOutside(root, path))
    throw new Error(`Dagr root configuration must stay inside its source root`)

  let code: string
  try {
    code = await readFile(path, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze({})
    throw error
  }

  const mod = new vm.SourceTextModule(code, { context, identifier: path })
  await mod.link((specifier) => {
    throw new Error(`Dagr root configuration cannot import ${specifier}`)
  })
  await mod.evaluate()
  const mount = (mod.namespace as Record<string, unknown>)['mount']
  if (mount !== undefined && typeof mount !== 'function')
    throw new Error(`Invalid Dagr root configuration: "mount" must be a function`)
  return Object.freeze({ mount: mount as MountResolver | undefined })
}

function isMountIndex(index: IndexDef): index is MountIndex {
  return Object.hasOwn(index, '/')
}

export class RepositoryPackageLoader implements PackageLoader {
  private readonly canonicalRoot: Promise<string>
  private readonly vmContext = createSandboxContext()
  private readonly builtins = createBuiltinModules(this.vmContext)
  private readonly moduleCache = new Map<string, vm.Module>()
  private readonly moduleContexts = new WeakMap<vm.Module, LoadContext>()
  private readonly indexCache = new Map<string, Promise<IndexDef | null>>()
  private readonly packageCache = new Map<string, Promise<LoadedPackage | undefined>>()
  private rootConfig?: Promise<RootConfig>
  private readonly mountImplCache = new Map<MountId, Promise<MountImpl | undefined>>()
  private readonly mountCache = new Map<MountId, Promise<MaterializedMount>>()
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

  async resolveCopySource(
    packageLogicalPath: string,
    source: string,
  ): Promise<ResolvedCopySource> {
    validateLogicalPath(packageLogicalPath)
    if (!source.includes(ROOT_MARKER))
      throw new Error(`Mounted COPY source must contain ${ROOT_MARKER}: ${source}`)

    let sourceRoot = await this.canonicalRoot
    let logicalRoot = '.'
    let trace: readonly MountTrace[] = []
    const packageParts = packageLogicalPath === '.' ? ['.'] : packageLogicalPath.split(ROOT_MARKER)
    let declarationPath = ''
    let packageDir = sourceRoot

    for (let i = 0; i < packageParts.length; i++) {
      const relativePath = packageParts[i]!
      declarationPath = i === 0
        ? relativePath
        : `${declarationPath}${ROOT_MARKER}${relativePath}`
      packageDir = relativePath === '.' || relativePath === ''
        ? sourceRoot
        : resolve(sourceRoot, relativePath)
      const index = await this.indexAt(packageDir, declarationPath, sourceRoot, logicalRoot, trace)

      if (i === packageParts.length - 1) {
        if (!index || isMountIndex(index))
          throw new Error(`Unknown package: ${packageLogicalPath}`)
        break
      }
      if (!index || !isMountIndex(index))
        throw new Error(`Unknown package: ${packageLogicalPath}`)

      const mounted = await this.materialize(index['/'], declarationPath, trace)
      sourceRoot = await realpath(mounted.root)
      logicalRoot = mountBoundary(declarationPath)
      trace = mounted.trace
    }

    const parts = source.split(ROOT_MARKER)
    let baseDir = packageDir
    let logicalBase = packageLogicalPath

    for (const mountPath of parts.slice(0, -1)) {
      validateCopyMountPath(mountPath, source)
      const mountDir = resolve(baseDir, mountPath)
      const mountLogicalPath = logicalBase === '.'
        ? mountPath
        : joinSourceLogical(logicalBase, mountPath)
      const index = await this.indexAt(
        mountDir,
        mountLogicalPath,
        sourceRoot,
        logicalRoot,
        trace,
      )
      if (!index || !isMountIndex(index))
        throw new Error(`COPY source crosses a non-mount path: ${source}`)

      const mounted = await this.materialize(index['/'], mountLogicalPath, trace)
      sourceRoot = await realpath(mounted.root)
      baseDir = sourceRoot
      logicalRoot = mountBoundary(mountLogicalPath)
      logicalBase = logicalRoot
      trace = mounted.trace
    }

    const src = parts.at(-1)!
    validateCopyRemainder(src, source)
    return { context: sourceRoot, src: src || '.' }
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
      moduleContexts: this.moduleContexts,
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
    id: MountId,
    logicalPath: string,
    trace: readonly MountTrace[],
  ): Promise<{ readonly root: string; readonly trace: readonly MountTrace[] }> {
    if (trace.some(entry => entry.id === id))
      throw new Error(
        `Circular mount: ${[...trace.map(entry => entry.logicalPath), logicalPath]
          .map(logicalAddress)
          .join(' -> ')}`,
      )

    let mount: MountImpl | undefined
    try {
      mount = await this.resolveMount(id)
    } catch (error) {
      throw new Error(
        `Cannot resolve mount "${id}" reached through ${logicalAddress(logicalPath)}: ${errorMessage(error)}`,
        { cause: error },
      )
    }
    if (mount === undefined)
      throw new Error(
        `Unresolved mount "${id}" reached through ${logicalAddress(logicalPath)}`,
      )
    if (!this.mountMaterializer)
      throw new Error(
        `Cannot load mount "${id}" reached through ${logicalAddress(logicalPath)}: no mount materializer configured`,
      )

    let materialized = this.mountCache.get(id)
    if (!materialized) {
      materialized = this.mountMaterializer.materialize(mount, id)
      this.mountCache.set(id, materialized)
    }
    let mounted: MaterializedMount
    try {
      mounted = await materialized
    } catch (error) {
      throw new Error(
        `Cannot materialize mount "${id}" reached through ${logicalAddress(logicalPath)}: ${errorMessage(error)}`,
        { cause: error },
      )
    }
    return {
      root: mounted.root,
      trace: [...trace, { id, logicalPath }],
    }
  }

  private resolveMount(id: MountId): Promise<MountImpl | undefined> {
    let resolved = this.mountImplCache.get(id)
    if (!resolved) {
      resolved = this.loadMountImpl(id)
      this.mountImplCache.set(id, resolved)
    }
    return resolved
  }

  private async loadMountImpl(id: MountId): Promise<MountImpl | undefined> {
    let config = this.rootConfig
    if (!config) {
      config = this.canonicalRoot.then(root => loadRootConfig(root, this.vmContext))
      this.rootConfig = config
    }
    const resolver = (await config).mount
    const mount = resolver?.(id)
    if (mount === undefined) return undefined

    const result = ImageRecipe.safeParse(mount)
    if (!result.success)
      throw new Error(`Invalid implementation: ${result.error.message}`)
    return deepFreeze(result.data)
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
    if (index && isMountIndex(index)) return
    if (index) this.remember(logicalRoot, index, root, acc)

    const entries = await readDirectories(root)
    await Promise.all(entries.map(entry => this.walk(
      resolve(root, entry),
      logicalRoot === '.'
        ? entry
        : joinLogical(logicalRoot, entry),
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
    if (index && isMountIndex(index)) return
    if (index) this.remember(logicalPath, index, dir, acc)

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
  return entries
    .filter(entry => entry.isDirectory() && !DISCOVERY_EXCLUDED_DIRECTORIES.has(entry.name))
    .map(entry => entry.name)
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

function validateCopyMountPath(path: string, source: string): void {
  if (
    !path ||
    path.includes('\\') ||
    isAbsolute(path) ||
    path.split('/').some(segment => !segment || segment === '.' || segment === '..')
  ) throw new Error(`Invalid mounted COPY source: ${source}`)
}

function validateCopyRemainder(path: string, source: string): void {
  if (
    path.includes('\\') ||
    isAbsolute(path) ||
    path.split('/').some(segment => segment === '..')
  ) throw new Error(`Invalid mounted COPY source: ${source}`)
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

function logicalAddress(logicalPath: string): string {
  return logicalPath === '.' ? ROOT_MARKER : `${ROOT_MARKER}${logicalPath}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
