import vm from 'node:vm'
import { readdir, readFile, realpath } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { parse as parseYaml } from 'yaml'
import { IndexDef, type MountDef, type MountIndex, type PackageDef } from '#pkg/schema.js'

const PACKAGE_FILE = 'dagr.index.js'
const IMPORT_FILE = /^dagr\..+\.(?:js|json|yaml|toml)$/

export interface PackageLoader {
  loadPackages(root: string): Promise<LoadedPackages>
}

export interface LoadedPackages {
  readonly definitions: ReadonlyMap<string, PackageDef>
  readonly contexts: ReadonlyMap<string, string>
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

interface LoadContext {
  readonly root: string
  readonly context: vm.Context
  readonly cache: Map<string, vm.Module>
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

async function importPath(specifier: string, ctx: LoadContext): Promise<string> {
  if (!specifier.startsWith('/') || specifier.startsWith('//'))
    throw new Error(`Dagr imports must start with /, got: ${specifier}`)

  const unresolved = resolve(ctx.root, `.${specifier}`)
  if (isOutside(ctx.root, unresolved))
    throw new Error(`Dagr imports must stay inside the monorepo root, got: ${specifier}`)
  if (!IMPORT_FILE.test(basename(unresolved)))
    throw new Error(
      `Dagr imports must target dagr.*.js, dagr.*.json, dagr.*.yaml, or dagr.*.toml, got: ${specifier}`
    )

  const path = await realpath(unresolved)
  if (isOutside(ctx.root, path))
    throw new Error(`Dagr imports must stay inside the monorepo root, got: ${specifier}`)
  return path
}

function parseData(path: string, source: string): unknown {
  switch (extname(path)) {
    case '.json': return JSON.parse(source)
    case '.yaml': return parseYaml(source)
    case '.toml': return parseToml(source)
    default: throw new Error(`Unsupported Dagr data file: ${path}`)
  }
}

async function link(specifier: string, ctx: LoadContext): Promise<vm.Module> {
  const path = await importPath(specifier, ctx)
  const cached = ctx.cache.get(path)
  if (cached) return cached

  if (extname(path) !== '.js') {
    const value = deepFreeze(parseData(path, await readFile(path, 'utf-8')))
    const mod = new vm.SyntheticModule(
      ['default'],
      function () { this.setExport('default', value) },
      { context: ctx.context, identifier: path }
    )
    ctx.cache.set(path, mod)
    return mod
  }

  const code = await readFile(path, 'utf-8')
  const mod = new vm.SourceTextModule(code, { context: ctx.context, identifier: path })
  ctx.cache.set(path, mod)
  await mod.link((nestedSpecifier) => link(nestedSpecifier, ctx))
  return mod
}

async function loadIndex(filePath: string, ctx: LoadContext): Promise<IndexDef | null> {
  const path = await realpath(filePath)
  if (isOutside(ctx.root, path))
    throw new Error(`Dagr index must stay inside its source root, got: ${filePath}`)

  const code = await readFile(path, 'utf-8')
  const mod = new vm.SourceTextModule(code, { context: ctx.context, identifier: path })
  await mod.link((specifier) => link(specifier, ctx))
  await mod.evaluate()
  const defaultExport = (mod.namespace as Record<string, unknown>)['default']
  const result = IndexDef.safeParse(defaultExport)
  return result.success ? deepFreeze(result.data) : null
}

function isMountIndex(index: IndexDef): index is MountIndex {
  return Object.hasOwn(index, '#mount')
}

export async function loadPackages(
  root: string,
  mountMaterializer?: MountMaterializer,
): Promise<LoadedPackages> {
  const canonicalRoot = await realpath(root)
  const ctx: LoadContext = {
    root: canonicalRoot,
    context: vm.createContext(Object.assign(Object.create(null), { Buffer })),
    cache: new Map(),
  }
  const definitions = new Map<string, PackageDef>()
  const contexts = new Map<string, string>()
  await loadRepository(canonicalRoot, '.', ctx, definitions, contexts, mountMaterializer, [])
  return Object.freeze({
    definitions: Object.freeze(definitions),
    contexts: Object.freeze(contexts),
  })
}

interface MountTrace {
  readonly identity: string
  readonly logicalPath: string
}

async function loadRepository(
  root: string,
  logicalRoot: string,
  ctx: LoadContext,
  acc: Map<string, PackageDef>,
  contexts: Map<string, string>,
  mountMaterializer: MountMaterializer | undefined,
  trace: readonly MountTrace[],
): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true })
  if (entries.some(e => !e.isDirectory() && e.name === PACKAGE_FILE)) {
    const index = await loadIndex(resolve(root, PACKAGE_FILE), ctx)
    if (index && isMountIndex(index)) {
      const mounted = await materialize(index['#mount'], logicalRoot, mountMaterializer, trace)
      const mountedRoot = await realpath(mounted.root)
      await loadRepository(
        mountedRoot,
        mountBoundary(logicalRoot),
        { ...ctx, root: mountedRoot },
        acc,
        contexts,
        mountMaterializer,
        mounted.trace,
      )
      return
    }
    if (index) {
      acc.set(logicalRoot, index)
      contexts.set(logicalRoot, root)
    }
  }

  const packages = resolve(root, 'packages')
  const packageEntries = await readdir(packages, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  await Promise.all(
    packageEntries
      .filter(e => e.isDirectory())
      .map(e => walk(
        resolve(packages, e.name),
        logicalRoot === '.'
          ? joinLogical('packages', e.name)
          : joinLogical(logicalRoot, 'packages', e.name),
        ctx,
        acc,
        contexts,
        mountMaterializer,
        trace,
      ))
  )
}

async function walk(
  dir: string,
  logicalPath: string,
  ctx: LoadContext,
  acc: Map<string, PackageDef>,
  contexts: Map<string, string>,
  mountMaterializer: MountMaterializer | undefined,
  trace: readonly MountTrace[],
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  if (entries.some(e => !e.isDirectory() && e.name === PACKAGE_FILE)) {
    const index = await loadIndex(resolve(dir, PACKAGE_FILE), ctx)
    if (index && isMountIndex(index)) {
      const mounted = await materialize(
        index['#mount'],
        logicalPath,
        mountMaterializer,
        trace,
      )
      const mountedRoot = await realpath(mounted.root)
      await walk(
        mountedRoot,
        mountBoundary(logicalPath),
        { ...ctx, root: mountedRoot },
        acc,
        contexts,
        mountMaterializer,
        mounted.trace,
      )
      return
    }
    if (index) {
      acc.set(logicalPath, index)
      contexts.set(logicalPath, dir)
    }
    return
  }
  await Promise.all(
    entries
      .filter(e => e.isDirectory())
      .map(e => walk(
        resolve(dir, e.name),
        joinLogical(logicalPath, e.name),
        ctx,
        acc,
        contexts,
        mountMaterializer,
        trace,
      ))
  )
}

function joinLogical(parent: string, ...children: readonly string[]): string {
  return [parent, ...children].reduce(
    (path, child) => path.endsWith('/') ? `${path}${child}` : `${path}/${child}`,
  )
}

function mountBoundary(logicalPath: string): string {
  return `${logicalPath.replace(/\/+$/, '')}//`
}

async function materialize(
  mount: MountDef,
  logicalPath: string,
  mountMaterializer: MountMaterializer | undefined,
  trace: readonly MountTrace[],
): Promise<{ readonly root: string; readonly trace: readonly MountTrace[] }> {
  if (!mountMaterializer)
    throw new Error(`Cannot load mount at ${logicalPath}: no mount materializer configured`)

  const mounted = await mountMaterializer.materialize(mount, logicalPath)
  if (trace.some(entry => entry.identity === mounted.identity))
    throw new Error(
      `Circular mount: ${[...trace.map(entry => entry.logicalPath), logicalPath].join(' -> ')}`,
    )

  return {
    root: mounted.root,
    trace: [...trace, { identity: mounted.identity, logicalPath }],
  }
}
