import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ProcessRunner } from '../process-runner.js'
import { copyScript, extractFromImage } from './docker-extractor.js'

describe('extractFromImage', () => {
  it('runs Docker with structured extraction context', async () => {
    const calls: Parameters<ProcessRunner['run']>[] = []
    const runner: ProcessRunner = {
      run: async (...args) => {
        calls.push(args)
        return {
          command: args[0],
          args: args[1],
          ...(args[2] ? { context: args[2] } : {}),
          exitCode: 0,
          signal: null,
          stdoutTail: [],
          stderrTail: [],
          durationMs: 1,
        }
      },
    }

    await extractFromImage('pkg-ci-build', { '/out': 'dist' }, '/repo/pkg', runner)

    assert.equal(calls[0]?.[0], 'docker')
    assert.deepEqual(calls[0]?.[2], {
      operation: 'image.extract',
      imageTag: 'pkg-ci-build',
      src: '/out',
      dest: 'dist',
      destDir: '/repo/pkg',
    })
  })
})

describe('copyScript', () => {
  it('replaces the destination when neither path has a trailing slash', () => {
    const script = copyScript('/docs', 'docs')
    assert.match(script, /rm -rf "\/host-out\/docs"/)
    assert.match(script, /cp -a "\/docs" "\/host-out\/docs"/)
  })

  it('treats a file the same as a directory', () => {
    const script = copyScript('/repo/package.json', 'package.json')
    assert.match(script, /rm -rf "\/host-out\/package\.json"/)
    assert.match(script, /cp -a "\/repo\/package\.json" "\/host-out\/package\.json"/)
  })

  it('merges contents and never deletes when the source ends in a slash', () => {
    const script = copyScript('/repo/dist/', 'dist/')
    assert.match(script, /cp -a "\/repo\/dist"\/\. "\/host-out\/dist"\//)
    assert.doesNotMatch(script, /rm -rf/)
  })

  it('places the node inside a destination ending in a slash', () => {
    const script = copyScript('/repo/dist', 'build/')
    assert.match(script, /cp -a "\/repo\/dist" "\/host-out\/build\/dist"/)
  })

  it('creates parent directories before copying', () => {
    assert.match(copyScript('/a/b.txt', 'nested/b.txt'), /mkdir -p "\$\(dirname "\/host-out\/nested\/b\.txt"\)"/)
  })

  it('merges into the package directory for ./', () => {
    const script = copyScript('/out/', './')
    assert.match(script, /cp -a "\/out"\/\. "\/host-out"\//)
    assert.doesNotMatch(script, /rm -rf/)
  })

  it('places a node inside the package directory for ./', () => {
    assert.match(copyScript('/repo/dist', './'), /rm -rf "\/host-out\/dist"/)
  })

  it('refuses to replace the package directory itself', () => {
    for (const dest of ['.', '']) {
      assert.throws(() => copyScript('/docs', dest), /cannot replace the package directory itself/)
    }
  })
})
