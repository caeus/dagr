import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { Module, toClass, toFactory, toValue, type ValidModule } from '@caeus/wyr'
import { AsyncDisposeStack } from '#sys/dispose-stack.js'
import { consoleReporter, type Reporter } from '#report/reporter.js'
import { processRunner, type ProcessRunner } from '#sys/process-runner.js'
import {
  loadPackages,
  type LoadedPackages,
  type MountMaterializer,
  type PackageLoader,
} from '#pkg/loader.js'
import type { HostPlatform, PackageDef, Run } from '#pkg/schema.js'
import { hostPlatform } from '#sys/host-platform.js'
import { buildRunner, type Runner } from '#runner/index.js'
import type { BuildResult } from '#runner/docker-builder.js'
import { renderDockerfile } from '#runner/dockerfile-renderer.js'
import { buildDockerImage } from '#runner/docker-builder.js'
import { extractFromImage } from '#runner/docker-extractor.js'
import { copyFromImage, type ImageCopy } from '#runner/docker-copier.js'
import { inspectImageWorkdir } from '#runner/docker-inspector.js'
import { createMountMaterializer } from '#runner/mount-materializer.js'
import {
  CompositeCommandRunner,
  ListCommandRunner,
  RunCommandRunner,
  parseCmd,
  type Cmd,
  type CommandRunner,
  type Output
} from '#commands/index.js'

export interface DockerfileRenderer {
  renderDockerfile(run: Run): string
}

export interface DockerImageBuilder {
  buildDockerImage(
    content: string,
    tag: string,
    context: string,
    ignore: readonly string[]
  ): Promise<BuildResult>
}

export interface DockerImageExtractor {
  extractFromImage(
    imageTag: string,
    exportMap: Readonly<Record<string, string>>,
    destDir: string
  ): Promise<void>
}

export interface DockerImageInspector {
  inspectImageWorkdir(imageTag: string): Promise<string>
}

export interface DockerImageCopier {
  copyFromImage(imageTag: string, copies: readonly ImageCopy[]): Promise<void>
}

export interface WiredCommand {
  readonly commandRunner: CommandRunner
}

export type ModuleFactory = (
  env: NodeJS.ProcessEnv,
  parsedArgs: Cmd,
  stack: AsyncDisposeStack
) => ValidModule<WiredCommand>

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
        buildDockerImage: (content, tag, context, ignore) =>
          buildDockerImage(content, tag, context, ignore, runner)
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
    mountMaterializer: toFactory(
      [
        'dockerfileRenderer',
        'dockerImageBuilder',
        'dockerImageCopier',
        'dockerImageInspector',
        'mountRoot'
      ],
      (
        renderer: DockerfileRenderer,
        builder: DockerImageBuilder,
        copier: DockerImageCopier,
        inspector: DockerImageInspector,
        mountRoot: string
      ) => createMountMaterializer({
        renderer,
        builder,
        copier,
        inspector,
        mountRoot
      })
    ),
    packageLoader: toFactory(
      ['mountMaterializer'],
      (mountMaterializer: MountMaterializer): PackageLoader => ({
        loadPackages: (root) => loadPackages(root, mountMaterializer)
      })
    ),
    loadedPackages: toFactory(
      ['root', 'packageLoader'],
      (root: string, loader: PackageLoader) => loader.loadPackages(root)
    ),
    packages: toFactory(
      ['loadedPackages'],
      (loaded: LoadedPackages) => loaded.definitions
    ),
    packageContexts: toFactory(
      ['loadedPackages'],
      (loaded: LoadedPackages) => loaded.contexts
    ),
    hostPlatform: toFactory(
      ['env'],
      (env: NodeJS.ProcessEnv): HostPlatform => hostPlatform(env)
    ),
    runner: toFactory(
      [
        'root',
        'packages',
        'packageContexts',
        'dockerfileRenderer',
        'dockerImageBuilder',
        'hostPlatform',
        'reporter'
      ],
      (
        root: string,
        packages: ReadonlyMap<string, PackageDef>,
        packageContexts: ReadonlyMap<string, string>,
        renderer: DockerfileRenderer,
        builder: DockerImageBuilder,
        host: HostPlatform,
        reporter: Reporter
      ): Runner =>
        buildRunner(
          root,
          packages,
          {
            renderDockerfile: (run) => renderer.renderDockerfile(run),
            buildDockerImage: (content, tag, context, ignore) =>
              builder.buildDockerImage(content, tag, context, ignore),
            reporter
          },
          host,
          packageContexts
        )
    ),
    listCommandRunner: toClass(['packages', 'output'], ListCommandRunner),
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
