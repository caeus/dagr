import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parse as parseYaml } from 'yaml'
import type { DockerImageExtractor } from '#runner/docker-extractor.js'
import { FQT, type Runner } from '#runner/index.js'
import type { PackageLoader } from '#pkg/loader.js'
import type { HostPlatform, PackageDef } from '#pkg/schema.js'
import {
  ListCommandRunner,
  PackageListCommandRunner,
  parseCmd,
  RunCommandRunner,
  ShowCommandRunner,
} from '#commands/index.js'

describe('parseCmd', () => {
  it('accepts multiple run targets', () => {
    assert.deepEqual(
      parseCmd(['run', '//packages/a:ci:test', '//packages/b:ci:test']),
      {
        command: 'run',
        verbose: false,
        fqts: ['//packages/a:ci:test', '//packages/b:ci:test']
      }
    )
  })

  it('accepts --verbose', () => {
    assert.deepEqual(
      parseCmd(['run', '--verbose', '//packages/a:ci:test']),
      { command: 'run', verbose: true, fqts: ['//packages/a:ci:test'] }
    )
  })

  it('accepts pkg ls', () => {
    assert.deepEqual(parseCmd(['pkg', 'ls']), { command: 'pkg-ls' })
  })

  it('accepts multiple show targets', () => {
    assert.deepEqual(
      parseCmd(['show', '//packages/a:ci:test', './b:ci:test']),
      { command: 'show', fqts: ['//packages/a:ci:test', './b:ci:test'] }
    )
  })
})

describe('RunCommandRunner', () => {
  it('runs every target and applies package context to each one', async () => {
    const ran: string[] = []
    const runner: Runner = async (fqt) => {
      ran.push(fqt.toString())
      return {
        fqt,
        imageTag: fqt.toString().replaceAll(':', '-'),
        imageDigest: 'sha256:test'
      }
    }
    const extractor: DockerImageExtractor = {
      extractFromImage: async () => undefined
    }

    await new RunCommandRunner(
      runner,
      extractor,
      '/',
      'packages/ui',
    ).execute({ command: 'run', verbose: false, fqts: ['ci:lint', 'ci:test'] })

    assert.deepEqual(ran, ['//packages/ui:ci:lint', '//packages/ui:ci:test'])
  })

  it('resolves a relative target against the working directory package', async () => {
    const ran: string[] = []
    const runner: Runner = async (fqt) => {
      ran.push(fqt.toString())
      return { fqt, imageTag: 'tag', imageDigest: 'sha256:test' }
    }

    await new RunCommandRunner(
      runner,
      { extractFromImage: async () => undefined },
      '/',
      'services',
    ).execute({ command: 'run', verbose: false, fqts: ['./api:ci:build', '.:ci:lint'] })

    assert.deepEqual(ran, ['//services/api:ci:build', '//services:ci:lint'])
  })

  it('resolves a relative target from the repository root', async () => {
    const ran: string[] = []
    const runner: Runner = async (fqt) => {
      ran.push(fqt.toString())
      return { fqt, imageTag: 'tag', imageDigest: 'sha256:test' }
    }

    await new RunCommandRunner(
      runner,
      { extractFromImage: async () => undefined },
      '/',
      '',
    ).execute({ command: 'run', verbose: false, fqts: ['./engine:ci:test'] })

    assert.deepEqual(ran, ['//engine:ci:test'])
  })

  it('extracts exports to the package directory', async () => {
    const extracted: Array<{ imageTag: string; destDir: string }> = []
    const runner: Runner = async (fqt) => ({
      fqt,
      imageTag: 'pkg-ci-build',
      imageDigest: 'sha256:test',
      export: { '/out': 'dist' }
    })
    const extractor: DockerImageExtractor = {
      extractFromImage: async (imageTag, _exportMap, destDir) => {
        extracted.push({ imageTag, destDir })
      }
    }

    await new RunCommandRunner(
      runner,
      extractor,
      '/repo',
      '',
    ).execute({ command: 'run', verbose: false, fqts: ['//pkg:ci:build'] })

    assert.deepEqual(extracted, [{ imageTag: 'pkg-ci-build', destDir: '/repo/pkg' }])
  })

  it('refuses to collapse a mounted package boundary for EXPORT', async () => {
    const result = {
      fqt: FQT.parse('//packages/tools//c:ci:pack'),
      imageTag: 'mounted-pack',
      imageDigest: 'sha256:mounted-pack',
      export: { '/out': 'dist' },
    }
    const runner: Runner = async () => result
    let extracted = false
    const extractor: DockerImageExtractor = {
      extractFromImage: async () => { extracted = true },
    }
    const command = new RunCommandRunner(runner, extractor, '/host/repo', '')

    await assert.rejects(
      command.execute({ command: 'run', verbose: false, fqts: [result.fqt.toString()] }),
      /Cannot EXPORT from a mounted package/,
    )
    assert.equal(extracted, false)
  })
})

describe('ShowCommandRunner', () => {
  const host: HostPlatform = { os: 'linux', arch: 'x64', libc: 'glibc' }
  const hello: PackageDef = {
    ci: {
      hello: {
        deps: [],
        run: () => ({ FROM: 'alpine:3.22', steps: [{ RUN: 'echo hi' }], IGNORE: ['.git'] }),
      },
    },
  }
  const showFrom = async (
    definition: PackageDef,
    currentPackage: string,
    ...fqts: readonly string[]
  ) => {
    const requested: string[] = []
    const lines: string[] = []
    await new ShowCommandRunner(
      {
        loadPackage: async (logicalPath) => {
          requested.push(logicalPath)
          return { definition, context: '/repo/pkg' }
        },
        loadAllPackages: async () => { throw new Error('show must not scan the repository') },
      },
      { write: line => lines.push(line) },
      host,
      currentPackage,
    ).execute({ command: 'show', fqts: [...fqts] })
    return { requested, text: lines.join('\n') }
  }

  it('renders the run definition as YAML', async () => {
    const { text } = await showFrom(hello, 'pkg', '//pkg:ci:hello')
    assert.deepEqual(parseYaml(text), {
      FROM: 'alpine:3.22',
      steps: [{ RUN: 'echo hi' }],
      IGNORE: ['.git'],
    })
  })

  it('labels the document with the resolved address', async () => {
    const { text } = await showFrom(hello, 'pkg', '//pkg:ci:hello')
    assert.equal(text.split('\n')[0], '# //pkg:ci:hello')
  })

  it('passes resolved dependency addresses as images', async () => {
    const definition: PackageDef = {
      ci: {
        build: {
          deps: ['ci:install', '//libraries/common:ci:pack'],
          run: ({ images }) => ({
            FROM: images['ci:install']!,
            steps: [{
              COPY: {
                from: images['//libraries/common:ci:pack']!,
                src: '/out/x.tgz',
                dest: '/x.tgz',
              },
            }],
            IGNORE: [],
          }),
        },
      },
    }

    const { text } = await showFrom(definition, 'pkg', '//pkg:ci:build')

    assert.deepEqual(parseYaml(text), {
      FROM: '//pkg:ci:install',
      steps: [{ COPY: { from: '//libraries/common:ci:pack', src: '/out/x.tgz', dest: '/x.tgz' } }],
      IGNORE: [],
    })
  })

  it('passes the host platform to run', async () => {
    const definition: PackageDef = {
      ci: {
        probe: {
          deps: [],
          run: ({ host: h }) => ({
            FROM: `${h.os}/${h.arch}/${h.libc}`,
            steps: [],
            IGNORE: [],
          }),
        },
      },
    }

    const { text } = await showFrom(definition, 'pkg', '//pkg:ci:probe')

    assert.equal((parseYaml(text) as { FROM: string }).FROM, 'linux/x64/glibc')
  })

  it('resolves a relative address against the working directory', async () => {
    const { requested, text } = await showFrom(hello, 'services', './api:ci:hello')
    assert.deepEqual(requested, ['services/api'])
    assert.equal(text.split('\n')[0], '# //services/api:ci:hello')
  })

  it('separates several targets as YAML documents', async () => {
    const { text } = await showFrom(hello, 'pkg', '//pkg:ci:hello', '//other:ci:hello')
    const documents = text.split('\n---\n')
    assert.equal(documents.length, 2)
    assert.equal(documents[0]?.split('\n')[0], '# //pkg:ci:hello')
    assert.equal(documents[1]?.split('\n')[0], '# //other:ci:hello')
  })

  it('keeps a long command on one line', async () => {
    const long = `node --experimental-vm-modules --enable-source-maps --import tsx/esm --test --test-reporter=spec 'src/**/*.test.ts'`
    const definition: PackageDef = {
      ci: { long: { deps: [], run: () => ({ FROM: 'alpine', steps: [{ RUN: long }], IGNORE: [] }) } },
    }

    const { text } = await showFrom(definition, 'pkg', '//pkg:ci:long')

    assert.ok(
      text.split('\n').some(line => line.includes(long)),
      `expected an unwrapped RUN line, got:\n${text}`,
    )
  })

  const recipe = () => ({ FROM: 'alpine', steps: [], IGNORE: [] })
  const workspace: PackageDef = {
    ci: {
      install: { deps: [], run: recipe },
      build: { deps: ['install'], run: recipe },
      test: { deps: ['ci:build', '//other:ci:pack'], run: recipe },
    },
    release: {
      publish: { deps: ['ci:build'], run: recipe },
    },
  }

  it('shows a facet as its targets with resolved dependencies', async () => {
    const { text } = await showFrom(workspace, 'pkg', '//pkg:ci')

    assert.equal(text.split('\n')[0], '# //pkg:ci')
    assert.deepEqual(parseYaml(text), {
      install: [],
      build: ['//pkg:ci:install'],
      test: ['//pkg:ci:build', '//other:ci:pack'],
    })
  })

  it('keeps declaration order within a facet', async () => {
    const { text } = await showFrom(workspace, 'pkg', '//pkg:ci')
    assert.deepEqual(Object.keys(parseYaml(text) as object), ['install', 'build', 'test'])
  })

  it('shows a package as its facets of targets', async () => {
    const { text } = await showFrom(workspace, 'pkg', '//pkg')

    assert.equal(text.split('\n')[0], '# //pkg')
    assert.deepEqual(parseYaml(text), {
      ci: {
        install: [],
        build: ['//pkg:ci:install'],
        test: ['//pkg:ci:build', '//other:ci:pack'],
      },
      release: { publish: ['//pkg:ci:build'] },
    })
  })

  it('shows a facet of the working directory package from a lone name', async () => {
    const { text } = await showFrom(workspace, 'pkg', 'ci')
    assert.equal(text.split('\n')[0], '# //pkg:ci')
  })

  it('never evaluates run when showing a facet or package', async () => {
    const exploding: PackageDef = {
      ci: { boom: { deps: [], run: () => { throw new Error('run must not be called') } } },
    }

    assert.deepEqual(parseYaml((await showFrom(exploding, 'pkg', '//pkg:ci')).text), { boom: [] })
    assert.deepEqual(
      parseYaml((await showFrom(exploding, 'pkg', '//pkg')).text),
      { ci: { boom: [] } },
    )
  })

  it('throws on an unknown facet', async () => {
    await assert.rejects(showFrom(workspace, 'pkg', '//pkg:absent'), /Unknown facet/)
  })

  it('throws on an unknown package', async () => {
    const command = new ShowCommandRunner(
      {
        loadPackage: async () => undefined,
        loadAllPackages: async () => { throw new Error('show must not scan the repository') },
      },
      { write: () => undefined },
      host,
      '',
    )

    await assert.rejects(
      command.execute({ command: 'show', fqts: ['//absent:ci:build'] }),
      /Unknown package/,
    )
  })

  it('throws on an unknown target', async () => {
    await assert.rejects(showFrom(hello, 'pkg', '//pkg:ci:absent'), /Unknown target/)
  })

  it('throws on an invalid run definition', async () => {
    const definition = {
      ci: { broken: { deps: [], run: () => ({ FROM: 'alpine' }) } },
    } as unknown as PackageDef

    await assert.rejects(
      showFrom(definition, 'pkg', '//pkg:ci:broken'),
      /Invalid run definition/,
    )
  })
})

describe('PackageListCommandRunner', () => {
  const leaf: PackageDef = {
    ci: { build: { deps: [], run: () => ({ FROM: 'alpine', steps: [], IGNORE: [] }) } },
  }
  const loaderWith = (...logicalPaths: readonly string[]): PackageLoader => ({
    loadPackage: async () => { throw new Error('pkg ls must not resolve individual packages') },
    loadAllPackages: async () => new Map(
      logicalPaths.map(path => [path, { definition: leaf, context: `/repo/${path}` }]),
    ),
  })
  const namesFrom = async (currentPackage: string, ...logicalPaths: readonly string[]) => {
    const lines: string[] = []
    await new PackageListCommandRunner(
      loaderWith(...logicalPaths),
      { write: line => lines.push(line) },
      currentPackage,
    ).execute()
    return lines
  }

  it('names packages under the working directory relative to it', async () => {
    assert.deepEqual(
      await namesFrom('services', 'services', 'services/api', 'services/web/admin'),
      ['.', './api', './web/admin'],
    )
  })

  it('lists every package from the repository root', async () => {
    assert.deepEqual(
      await namesFrom('', '.', 'engine', 'stacks'),
      ['.', './engine', './stacks'],
    )
  })

  it('excludes packages outside the working directory', async () => {
    assert.deepEqual(
      await namesFrom('services', 'engine', 'services/api', 'tools'),
      ['./api'],
    )
  })

  it('does not treat a name-prefix sibling as a descendant', async () => {
    assert.deepEqual(await namesFrom('engine', 'engineering', 'engine/examples'), ['./examples'])
  })

  it('prints nothing when no package is under the working directory', async () => {
    assert.deepEqual(await namesFrom('docs', 'engine'), [])
  })

  it('names packages under a mounted working directory', async () => {
    assert.deepEqual(await namesFrom('tools//b', 'tools//b', 'tools//b/c'), ['.', './c'])
  })
})

describe('ListCommandRunner', () => {
  it('requests the explicit full package scan only when executed', async () => {
    let scans = 0
    const definition: PackageDef = {
      ci: {
        build: {
          deps: ['//stacks/ts//:ci:build'],
          run: () => ({ FROM: 'alpine', steps: [], IGNORE: [] }),
        },
      },
    }
    const packages: PackageLoader = {
      loadPackage: async () => { throw new Error('list must not resolve individual packages') },
      loadAllPackages: async () => {
        scans++
        return new Map([['packages/ui', { definition, context: '/repo/packages/ui' }]])
      },
    }
    const lines: string[] = []
    const command = new ListCommandRunner(packages, { write: line => lines.push(line) })

    assert.equal(scans, 0)
    await command.execute()

    assert.equal(scans, 1)
    assert.deepEqual(lines, [
      '//packages/ui:ci:build[//stacks/ts//:ci:build]',
    ])
  })
})
