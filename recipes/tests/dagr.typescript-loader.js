import { readFile, realpath } from 'node:fs/promises'
import { dirname, extname, matchesGlob, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repository = resolve(root, '..')
const engine = resolve(repository, 'engine')
const recipe = resolve(root, 'typescript')
const rdkFixture = resolve(root, 'tests/dagr.rdk-fixture.js')

// Recipe tests stay self-contained, so this mirrors the engine-provided glob used by the RDK fixture.
const globOf = pattern => Object.freeze(path => matchesGlob(path, pattern))

const synthetic = async (specifier, exports) => {
  const names = Object.keys(exports)
  const module = new vm.SyntheticModule(names, function () {
    for (const name of names) this.setExport(name, exports[name])
  }, { identifier: specifier })
  await module.link(() => {})
  return module
}

const createLoader = () => {
  const cache = new Map()
  const linking = new Map()

  const load = async path => {
    const canonical = await realpath(path)
    if (cache.has(canonical)) {
      await linking.get(canonical)
      return cache.get(canonical)
    }

    if (extname(canonical) === '.yaml') {
      const module = new vm.SyntheticModule(['default'], function () {
        this.setExport('default', { deps: {} })
      }, { identifier: canonical })
      cache.set(canonical, module)
      linking.set(canonical, module.link(() => {}))
      await linking.get(canonical)
      return module
    }

    const module = new vm.SourceTextModule(await readFile(canonical, 'utf8'), {
      identifier: canonical,
      initializeImportMeta(meta) {
        meta.dagr = { location: '//engine' }
      },
    })
    cache.set(canonical, module)
    let resolveLinked
    let rejectLinked
    const linked = new Promise((resolve, reject) => {
      resolveLinked = resolve
      rejectLinked = reject
    })
    linking.set(canonical, linked)
    module.link(async specifier => {
      if (specifier === 'dagr:yaml') {
        return synthetic(specifier, { stringify: value => JSON.stringify(value, null, 2) })
      }
      if (specifier === 'dagr:glob') {
        return synthetic(specifier, { default: Object.freeze({ of: globOf }), of: globOf })
      }
      if (specifier === 'dagr:rdk') return load(rdkFixture)
      if (!specifier.startsWith('//')) {
        throw new Error(`Dagr imports must start with //, got: ${specifier}`)
      }
      if (specifier.startsWith('//engine/recipes/typescript//')) {
        return load(resolve(recipe, specifier.slice('//engine/recipes/typescript//'.length)))
      }
      if (specifier.startsWith('//engine/')) {
        return load(resolve(repository, specifier.slice(2)))
      }
      return load(resolve(recipe, specifier.slice(2)))
    }).then(resolveLinked, rejectLinked)
    await linked
    return module
  }

  return load
}

const evaluate = async path => {
  const module = await createLoader()(path)
  await module.evaluate()
  return module.namespace
}

export const loadTypeScript = () => evaluate(resolve(recipe, 'dagr.recipe.js'))

export const loadEngineIndex = () => evaluate(resolve(engine, 'dagr.index.js'))
