import vm from 'node:vm'
import { readdir, readFile, realpath } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { parse as parseYaml } from 'yaml'
import { BUILTIN_PREFIX, createBuiltinModules } from '#pkg/builtins.js'
import { ROOT_MARKER } from '#pkg/namespace.js'
import { createSandboxContext } from '#pkg/sandbox.js'
import {
  IndexDef,
  type MountImplementation,
  type PackageDef,
  type VolumeId,
} from '#pkg/schema.js'
import { MountRequestLoader, canonicalMountPath } from '#pkg/mount-request.js'
import { RootVolumeRegistry } from '#pkg/volume-registry.js'
import { deepFreeze } from '#pkg/value.js'

const PACKAGE_FILE = 'dagr.index.js'
const IMPORT_FILE = /^dagr\..+\.(?:js|json|yaml|toml)$/
const DISCOVERY_EXCLUDED_DIRECTORIES = new Set(['.dagr', '.git'])

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

export interface MaterializedVolume {
  readonly root: string
}

export interface VolumeMaterializer {
  materialize(
    volumeId: VolumeId,
    implementation: MountImplementation,
    logicalPath: string,
  ): Promise<MaterializedVolume>
}

interface MountTrace {
  readonly volumeId: VolumeId
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
  readonly moduleContexts: WeakMap<vm.Module, LoadContext>
  readonly resolveImport: (specifier: string, context: LoadContext) => Promise<ResolvedImport>
}

interface TraversalState {
  readonly sourceRoot: string
  readonly logicalRoot: string
  readonly trace: readonly MountTrace[]
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
  const location = packageLocation(logicalPath)
  let path: string
  try {
    path = await realpath(filePath)
  } catch (error) {
    if (isMissing(error)) throw error
    throw new Error(`Cannot resolve Dagr index at ${location}`, { cause: error })
  }
  if (isOutside(ctx.root, path))
    throw new Error(`Dagr index at ${location} must stay inside its source root`)

  let code: string
  try {
    code = await readFile(path, 'utf-8')
  } catch (error) {
    throw new Error(`Cannot read Dagr index at ${location}`, { cause: error })
  }
  const dagr = Object.freeze(Object.assign(Object.create(null), {
    location,
  }))
  let mod: vm.SourceTextModule
  try {
    mod = new vm.SourceTextModule(code, {
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
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Cannot evaluate Dagr index at ${location}: ${detail}`, { cause: error })
  }
  const defaultExport = (mod.namespace as Record<string, unknown>)['default']
  if (isLegacyMountIndex(defaultExport))
    throw new Error(
      `Invalid Dagr index at ${location}: the former { "/": mountImplementation } shape is not supported; use dagr.mount.yaml and root .dagr/volumes.yaml`,
    )
  let result: ReturnType<typeof IndexDef.safeParse>
  try {
    result = IndexDef.safeParse(defaultExport)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid Dagr index at ${location}: ${detail}`, { cause: error })
  }
  if (result.success) return deepFreeze(result.data)
  throw new Error(
    `Invalid Dagr index at ${location}: ${result.error.message}`,
  )
}

function isLegacyMountIndex(value: unknown): boolean {
  return value !== null && typeof value === 'object' && Object.hasOwn(value, '/')
}

export class RepositoryPackageLoader implements PackageLoader {
  private readonly canonicalRoot: Promise<string>
  private readonly vmContext = createSandboxContext()
  private readonly builtins = createBuiltinModules(this.vmContext)
  private readonly moduleCache = new Map<string, vm.Module>()
  private readonly moduleContexts = new WeakMap<vm.Module, LoadContext>()
  private readonly indexCache = new Map<string, Promise<IndexDef | null>>()
  private readonly mountRequests = new MountRequestLoader()
  private readonly volumes: RootVolumeRegistry
  private readonly packageCache = new Map<string, Promise<LoadedPackage | undefined>>()
  private readonly volumeCache = new Map<VolumeId, Promise<MaterializedVolume>>()
  private allPackages?: Promise<ReadonlyMap<string, LoadedPackage>>

  constructor(
    root: string,
    private readonly volumeMaterializer?: VolumeMaterializer,
  ) {
    this.canonicalRoot = realpath(root)
    this.volumes = new RootVolumeRegistry(root)
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

      if (i === packageParts.length - 1) {
        const index = await this.indexAt(
          packageDir,
          declarationPath,
          sourceRoot,
          logicalRoot,
          trace,
        )
        if (!index)
          throw new Error(`Unknown package: ${packageLogicalPath}`)
        break
      }
      const crossed = await this.crossMount(packageDir, declarationPath, {
        sourceRoot,
        logicalRoot,
        trace,
      })
      if (!crossed)
        throw new Error(`Unknown package: ${packageLogicalPath}`)
      sourceRoot = crossed.sourceRoot
      logicalRoot = crossed.logicalRoot
      trace = crossed.trace
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
      const crossed = await this.crossMount(mountDir, mountLogicalPath, {
        sourceRoot,
        logicalRoot,
        trace,
      })
      if (!crossed)
        throw new Error(`COPY source crosses a non-mount path: ${source}`)
      sourceRoot = crossed.sourceRoot
      baseDir = sourceRoot
      logicalRoot = crossed.logicalRoot
      logicalBase = logicalRoot
      trace = crossed.trace
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
      ).catch((error: unknown) => {
        if (isMissing(error)) return null
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

      if (i === parts.length - 1) {
        const index = await this.indexAt(dir, declarationPath, sourceRoot, logicalRoot, trace)
        if (!index) return undefined
        return Object.freeze({ definition: index, context: dir })
      }
      const crossed = await this.crossMount(dir, declarationPath, {
        sourceRoot,
        logicalRoot,
        trace,
      })
      if (!crossed) return undefined
      sourceRoot = crossed.sourceRoot
      logicalRoot = crossed.logicalRoot
      trace = crossed.trace
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
      const crossed = await this.crossMount(declarationDir, declarationPath, {
        sourceRoot,
        logicalRoot,
        trace,
      })
      if (!crossed)
        throw new Error(`Dagr import crosses a non-mount path: ${specifier}`)
      sourceRoot = crossed.sourceRoot
      logicalRoot = crossed.logicalRoot
      trace = crossed.trace
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

  private async crossMount(
    dir: string,
    logicalPath: string,
    state: TraversalState,
  ): Promise<TraversalState | undefined> {
    const request = await this.mountRequests.load(dir, logicalPath)
    if (request === undefined) return undefined

    const { id, implementation } = await this.volumes.resolve(request, logicalPath)
    if (state.trace.some(entry => entry.volumeId === id))
      throw new Error(
        `Circular volume ${JSON.stringify(id)}: ${[
          ...state.trace.map(entry => canonicalMountPath(entry.logicalPath)),
          canonicalMountPath(logicalPath),
        ].join(' -> ')}`,
      )
    if (!this.volumeMaterializer)
      throw new Error(
        `Cannot materialize volume ${JSON.stringify(id)} requested through mount ${canonicalMountPath(logicalPath)}: no volume materializer configured`,
      )

    let materialized = this.volumeCache.get(id)
    if (!materialized) {
      materialized = this.volumeMaterializer.materialize(id, implementation, logicalPath)
      this.volumeCache.set(id, materialized)
    }
    let mounted: MaterializedVolume
    try {
      mounted = await materialized
    } catch (error) {
      throw new Error(
        `Failed to materialize volume ${JSON.stringify(id)} requested through mount ${canonicalMountPath(logicalPath)}`,
        { cause: error },
      )
    }

    let sourceRoot: string
    try {
      sourceRoot = await realpath(mounted.root)
    } catch (error) {
      throw new Error(
        `Materialized volume ${JSON.stringify(id)} requested through mount ${canonicalMountPath(logicalPath)} has no readable root`,
        { cause: error },
      )
    }
    return {
      sourceRoot,
      logicalRoot: mountBoundary(logicalPath),
      trace: [...state.trace, { volumeId: id, logicalPath }],
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
    const request = await this.mountRequests.load(dir, logicalPath)
    const index = await this.indexAt(dir, logicalPath, sourceRoot, sourceLogicalRoot, trace)
    if (index) this.remember(logicalPath, index, dir, acc)
    if (request !== undefined) return

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
    if (isMissing(error)) return []
    throw error
  })
  return entries
    .filter(entry => entry.isDirectory() && !DISCOVERY_EXCLUDED_DIRECTORIES.has(entry.name))
    .map(entry => entry.name)
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
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
