import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Reporter } from '#report/reporter.js'
import { FQT } from '#runner/index.js'
import { runTarget, type TargetRunnerDeps } from '#runner/target-runner.js'
import type { Run, TargetDef } from '#pkg/schema.js'

const reporter: Reporter = {
  targetStarted: () => undefined,
  targetCompleted: () => undefined,
  targetFailed: () => undefined,
  processLine: () => undefined,
  failure: () => undefined,
}

describe('mounted COPY sources', () => {
  it('rewrites x//path to a named build context and reuses the context', async () => {
    let rendered: Run | undefined
    let buildContexts: Readonly<Record<string, string>> | undefined
    const resolved: string[] = []

    const target: TargetDef = {
      deps: [],
      run: () => ({
        FROM: 'alpine',
        steps: [
          { COPY: { src: 'local.txt', dest: '/local.txt' } },
          { COPY: { src: 'tools//include/a.h', dest: '/include/a.h' } },
          { COPY: { src: 'tools//include/b.h', dest: '/include/b.h' } },
          { COPY: { from: 'other-image', src: 'tools//inside-image', dest: '/image' } },
        ],
        IGNORE: [],
      }),
    }
    const deps: TargetRunnerDeps = {
      renderDockerfile: (run) => {
        rendered = run
        return 'FROM alpine\n'
      },
      buildDockerImage: async (_content, tag, _context, _ignore, contexts) => {
        buildContexts = contexts
        return { tag, digest: 'sha256:test' }
      },
      reporter,
    }

    await runTarget(
      FQT.parse('//packages/app:ci:build'),
      target,
      [],
      '/repo/packages/app',
      deps,
      { os: 'linux', arch: 'x64' },
      async (source) => {
        resolved.push(source)
        return {
          context: '/mounts/tools',
          src: source.slice(source.indexOf('//') + 2),
        }
      },
    )

    assert.deepEqual(resolved, ['tools//include/a.h', 'tools//include/b.h'])
    assert.deepEqual(rendered?.steps, [
      { COPY: { src: 'local.txt', dest: '/local.txt' } },
      { COPY: { from: 'dagr_mount_0', src: 'include/a.h', dest: '/include/a.h' } },
      { COPY: { from: 'dagr_mount_0', src: 'include/b.h', dest: '/include/b.h' } },
      { COPY: { from: 'other-image', src: 'tools//inside-image', dest: '/image' } },
    ])
    assert.deepEqual(buildContexts, { dagr_mount_0: '/mounts/tools' })
  })
})
