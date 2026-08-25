import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { DockerImageExtractor } from '#runner/docker-extractor.js'
import { FQT, type Runner } from '#runner/index.js'
import { parseCmd, RunCommandRunner } from '#commands/index.js'

describe('parseCmd', () => {
  it('accepts multiple run targets', () => {
    assert.deepEqual(
      parseCmd(['run', 'packages/a#ci#test', 'packages/b#ci#test']),
      {
        command: 'run',
        verbose: false,
        fqts: ['packages/a#ci#test', 'packages/b#ci#test']
      }
    )
  })

  it('accepts --verbose', () => {
    assert.deepEqual(
      parseCmd(['run', '--verbose', 'packages/a#ci#test']),
      { command: 'run', verbose: true, fqts: ['packages/a#ci#test'] }
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
        imageTag: fqt.toString().replaceAll('#', '-'),
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
    ).execute({ command: 'run', verbose: false, fqts: ['ci#lint', 'ci#test'] })

    assert.deepEqual(ran, ['packages/ui#ci#lint', 'packages/ui#ci#test'])
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
    ).execute({ command: 'run', verbose: false, fqts: ['pkg#ci#build'] })

    assert.deepEqual(extracted, [{ imageTag: 'pkg-ci-build', destDir: '/repo/pkg' }])
  })

  it('refuses to collapse a mounted package boundary for EXPORT', async () => {
    const result = {
      fqt: FQT.parse('packages/tools//c#ci#pack'),
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
