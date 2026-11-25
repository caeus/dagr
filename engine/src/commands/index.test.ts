import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parse as parseYaml } from 'yaml'
import { FQT, type Runner } from '#runner/index.js'
import { loadedPackage, type PackageLoader } from '#pkg/loader.js'
import type { PackageDef } from '#pkg/schema.js'
import { ListCommandRunner, PackageListCommandRunner, parseCmd, RunCommandRunner, ShowCommandRunner } from '#commands/index.js'

const graph = {
  '/app/install': { deps: {}, run: () => ({ value: 'base' }) },
  '/app/build': {
    deps: { base: '/app/install', config: '/app/file/*' },
    run: () => { throw new Error('must not evaluate during inspection') },
  },
  '/app/file/config': { deps: {}, run: () => ({ value: 'config' }) },
} satisfies PackageDef
const loader = (packages: Record<string, PackageDef>): PackageLoader => ({
  async loadPackage(name) {
    const graph = packages[name]
    return graph && loadedPackage(graph, '/' + name)
  },
  async loadAllPackages() {
    return new Map(Object.entries(packages).map(([name, graph]) => [name, loadedPackage(graph, '/' + name)]))
  },
})

describe('parseCmd', () => {
  it('parses run with multiple nodes and verbose', () => {
    assert.deepEqual(parseCmd(['run', '--verbose', '//a:/app/build', '/app/test']), {
      command: 'run', verbose: true, fqts: ['//a:/app/build', '/app/test'],
    })
  })
  it('parses list, show and pkg ls', () => {
    assert.deepEqual(parseCmd(['pkg', 'ls']), { command: 'pkg-ls' })
    assert.deepEqual(parseCmd(['list']), { command: 'list' })
    assert.deepEqual(parseCmd(['show', '//a:/app/build']), { command: 'show', fqts: ['//a:/app/build'] })
  })
})

describe('RunCommandRunner', () => {
  it('resolves local and qualified nodes and extracts requested build outputs only', async () => {
    const ran: string[] = []
    const extracted: string[] = []
    const runner: Runner = async fqt => {
      ran.push(fqt.toString())
      return fqt.path === '/app/build'
        ? { fqt, value: 'tag', build: { imageTag: 'tag', imageDigest: 'sha256:test', export: { '/out': 'dist' } } }
        : { fqt, value: 42 }
    }
    await new RunCommandRunner(runner, {
      async extractFromImage(tag, _map, dir) { extracted.push(tag + ':' + dir) },
    }, '/repo', '//pkg').execute({
      command: 'run', verbose: false, fqts: ['/app/build', '//other:/value'],
    })
    assert.deepEqual(ran, ['//pkg:/app/build', '//other:/value'])
    assert.deepEqual(extracted, ['tag:/repo/pkg'])
  })

  it('rejects host materialization from a mounted project', async () => {
    const fqt = FQT.parse('//tools//pkg:/pack')
    const runner: Runner = async () => ({
      fqt, value: 'tag', build: { imageTag: 'tag', imageDigest: 'sha256:test', export: { '/out': 'dist' } },
    })
    await assert.rejects(new RunCommandRunner(runner, {
      async extractFromImage() { throw new Error('must not extract') },
    }, '/repo', '//').execute({ command: 'run', verbose: false, fqts: [fqt.toString()] }), /Cannot EXPORT/)
  })
})

describe('ShowCommandRunner', () => {
  it('shows resolved named dependencies without running a node', async () => {
    const lines: string[] = []
    await new ShowCommandRunner(loader({ pkg: graph }), { write: line => lines.push(line) }, '//pkg')
      .execute({ command: 'show', fqts: ['/app/build'] })
    assert.match(lines[0]!, /^# \/\/pkg:\/app\/build/)
    assert.deepEqual(parseYaml(lines[0]!), {
      deps: { base: '//pkg:/app/install', config: ['//pkg:/app/file/config'] },
    })
  })
  it('fails on missing node', async () => {
    await assert.rejects(new ShowCommandRunner(loader({ pkg: graph }), { write() {} }, '//pkg')
      .execute({ command: 'show', fqts: ['/missing'] }), /Unknown node/)
  })
})

describe('ListCommandRunner', () => {
  it('lists the final graph with dependencies before dependants', async () => {
    const lines: string[] = []
    await new ListCommandRunner(loader({ pkg: graph }), { write: line => lines.push(line) }).execute()
    assert.deepEqual(lines, [
      '//pkg:/app/install[]',
      '//pkg:/app/file/config[]',
      '//pkg:/app/build[//pkg:/app/install, //pkg:/app/file/config]',
    ])
  })
})

describe('PackageListCommandRunner', () => {
  it('lists only descendants relative to the working project', async () => {
    const lines: string[] = []
    await new PackageListCommandRunner(loader({
      engine: {}, 'engine/examples': {}, engineering: {}, other: {},
    }), { write: line => lines.push(line) }, '//engine').execute()
    assert.deepEqual(lines, ['.', './examples'])
  })
})
