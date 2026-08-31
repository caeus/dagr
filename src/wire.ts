import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { Module, toClass, toFactory, toValue, type ValidModule } from '@caeus/wyr'
import { AsyncDisposeStack } from '#sys/dispose-stack.js'
import { consoleReporter, type Reporter } from '#report/reporter.js'
import { processRunner, type ProcessRunner } from '#sys/process-runner.js'
import {
  RepositoryPackageLoader,
  type MountMaterializer,
  type PackageLoader,
} from '#pkg/loader.js'
import type { HostPlatform } from '#pkg/schema.js'
import { hostPlatform } from '#sys/host-platform.js'
import { buildRunner, type Runner } from '#runner/index.js'
import { renderDockerfile, type DockerfileRenderer } from '#runner/dockerfile-renderer.js'
import { buildDockerImage, type DockerImageBuilder } from '#runner/docker-builder.js'
import { extractFromImage, type DockerImageExtractor } from '#runner/docker-extractor.js'
import { copyFromImage, type DockerImageCopier } from '#runner/docker-copier.js'
import { inspectImageWorkdir, type DockerImageInspector } from '#runner/docker-inspector.js'
import { DockerMountMaterializer } from '#runner/mount-materializer.js'
import {
  CompositeCommandRunner,
  ListCommandRunner,
  RunCommandRunner,
  parseCmd,
  type Cmd,
  type CommandRunner,
  type Output
} from '#commands/index.js'

export type ModuleFactory = (
  env: NodeJS.ProcessEnv,
  parsedArgs: Cmd,
  stack: AsyncDisposeStack
) => ValidModule<{ readonly commandRunner: CommandRunner }>

export function defaultModule(
  env: NodeJS.ProcessEnv,
  cmd: Cmd,
  stack: AsyncDisposeStack
) {
  const mountRoot = env['MOUNT_ROOT'] ?? join(tmpdir(), `dagr-mounts-${process.pid}`)
  const cleanMountRoot = env['CLEAN_MOUNT_ROOT'] === '1' || env['MOUNT_ROOT'] === undefined
  if (cleanMountRoot && mountRoot !== '/')
    stack.defer(() => rm(mountRoot, { recursive: true, force: true }))

  return Module({
    env: toValue(env),
    root: toFactory(
      ['env'],
      (env: NodeJS.ProcessEnv) =>
        env['REPO_ROOT'] ?? resolve(new URL('../../', import.meta.url).pathname)
    ),
    hostRoot: toFactory(
      ['env', 'root'],
      (env: NodeJS.ProcessEnv, root: string) => env['HOST_REPO_ROOT'] ?? root
    ),
    mountRoot: toValue(mountRoot),
    currentPackage: toFactory(
      ['env', 'hostRoot'],
      (env: NodeJS.ProcessEnv, hostRoot: string) =>
        relative(hostRoot, env['WORKING_DIR'] ?? hostRoot)
    ),
    reporter: toValue(
      consoleReporter({
        verbose: cmd.command === 'run' && cmd.verbose === true
      }) satisfies Reporter
    ),
    output: toValue({
      write: (line: string) => process.stdout.write(`${line}\n`)
    } satisfies Output),
    processRunner: toFactory(
      ['reporter'],
      (reporter: Reporter): ProcessRunner => processRunner(reporter)
    ),
    dockerfileRenderer: toValue({ renderDockerfile } satisfies DockerfileRenderer),
    dockerImageBuilder: toFactory(
      ['processRunner'],
      (runner: ProcessRunner): DockerImageBuilder => ({
        buildDockerImage: (content, tag, context, ignore, buildContexts) =>
          buildDockerImage(content, tag, context, ignore, runner, buildContexts)
      })
    ),
    dockerImageExtractor: toFactory(
      ['processRunner'],
      (runner: ProcessRunner): DockerImageExtractor => ({
        extractFromImage: (imageTag, exportMap, destDir) =>
          extractFromImage(imageTag, exportMap, destDir, runner)
      })
    ),
    dockerImageInspector: toFactory(
      ['processRunner'],
      (runner: ProcessRunner): DockerImageInspector => ({
        inspectImageWorkdir: (imageTag) => inspectImageWorkdir(imageTag, runner)
      })
    ),
    dockerImageCopier: toFactory(
      ['processRunner'],
      (runner: ProcessRunner): DockerImageCopier => ({
        copyFromImage: (imageTag, copies) => copyFromImage(imageTag, copies, runner)
      })
    ),
    mountMaterializer: toClass(
      [
        'dockerfileRenderer',
        'dockerImageBuilder',
        'dockerImageCopier',
        'dockerImageInspector',
        'mountRoot'
      ],
      DockerMountMaterializer
    ),
    packageLoader: toFactory(
      ['root', 'mountMaterializer'],
      (root: string, mountMaterializer: MountMaterializer): PackageLoader =>
        new RepositoryPackageLoader(root, mountMaterializer)
    ),
    hostPlatform: toFactory(
      ['env'],
      (env: NodeJS.ProcessEnv): HostPlatform => hostPlatform(env)
    ),
    runner: toFactory(
      [
        'packageLoader',
        'dockerfileRenderer',
        'dockerImageBuilder',
        'hostPlatform',
        'reporter'
      ],
      (
        packageLoader: PackageLoader,
        renderer: DockerfileRenderer,
        builder: DockerImageBuilder,
        host: HostPlatform,
        reporter: Reporter
      ): Runner =>
        buildRunner(
          packageLoader,
          {
            renderDockerfile: (run) => renderer.renderDockerfile(run),
            buildDockerImage: (content, tag, context, ignore, buildContexts) =>
              builder.buildDockerImage(content, tag, context, ignore, buildContexts),
            reporter
          },
          host
        )
    ),
    listCommandRunner: toClass(['packageLoader', 'output'], ListCommandRunner),
    runCommandRunner: toClass(
      ['runner', 'dockerImageExtractor', 'root', 'currentPackage'],
      RunCommandRunner
    ),
    commandRunner: toClass(
      ['runCommandRunner', 'listCommandRunner'],
      CompositeCommandRunner
    )
  }).shake(['commandRunner'])
}

export async function wire(
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv.slice(2),
  module: ModuleFactory = defaultModule
): Promise<void> {
  const parsedArgs = parseCmd(args)
  const stack = new AsyncDisposeStack()

  try {
    const container = await module(env, parsedArgs, stack).compile()
    await container.get('commandRunner').execute(parsedArgs)
  } finally {
    await stack.dispose()
  }
}
