import vm from 'node:vm'
import { readdir, readFile, realpath } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { parse as parseYaml } from 'yaml'
import { PackageDef } from './schema.js'

const PACKAGE_FILE = 'dagr.index.js'
const IMPORT_FILE = /^dagr\..+\.(?:js|json|yaml|toml)$/

export interface PackageLoader {
  loadPackages(root: string): Promise<ReadonlyMap<string, PackageDef>>
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

async function loadPackage(filePath: string, ctx: LoadContext): Promise<PackageDef | null> {
  const code = await readFile(filePath, 'utf-8')
  const mod = new vm.SourceTextModule(code, { context: ctx.context, identifier: filePath })
  await mod.link((specifier) => link(specifier, ctx))
  await mod.evaluate()
  const defaultExport = (mod.namespace as Record<string, unknown>)['default']
  const result = PackageDef.safeParse(defaultExport)
  return result.success ? deepFreeze(result.data) : null
}

export async function loadPackages(root: string): Promise<ReadonlyMap<string, PackageDef>> {
  const canonicalRoot = await realpath(root)
  const ctx: LoadContext = {
    root: canonicalRoot,
    context: vm.createContext(Object.assign(Object.create(null), { Buffer })),
    cache: new Map(),
  }
  const result = new Map<string, PackageDef>()
  const rootEntries = await readdir(canonicalRoot, { withFileTypes: true })
  if (rootEntries.some(e => !e.isDirectory() && e.name === PACKAGE_FILE)) {
    const pkg = await loadPackage(resolve(canonicalRoot, PACKAGE_FILE), ctx)
    if (pkg) result.set('.', pkg)
  }
  await walk(resolve(canonicalRoot, 'packages'), ctx, result)
  return Object.freeze(result)
}

async function walk(dir: string, ctx: LoadContext, acc: Map<string, PackageDef>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  if (entries.some(e => !e.isDirectory() && e.name === PACKAGE_FILE)) {
    const pkg = await loadPackage(resolve(dir, PACKAGE_FILE), ctx)
    if (pkg) acc.set(relative(ctx.root, dir), pkg)
    return
  }
  await Promise.all(
    entries
      .filter(e => e.isDirectory())
      .map(e => walk(resolve(dir, e.name), ctx, acc))
  )
}
