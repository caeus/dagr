import { relative, resolve } from 'node:path'
import { Module, toClass, toFactory, toValue, type ValidModule } from '@caeus/wyr'
import { AsyncDisposeStack } from '#sys/dispose-stack.js'
import { consoleReporter, type Reporter } from '#report/reporter.js'
import { processRunner, type ProcessRunner } from '#sys/process-runner.js'
import { loadPackages, type PackageLoader } from '#pkg/loader.js'
import type { HostPlatform, PackageDef, Run } from '#pkg/schema.js'
import { hostPlatform } from '#sys/host-platform.js'
import { buildRunner, type Runner } from '#runner/index.js'
import type { BuildResult } from '#runner/docker-builder.js'
import { renderDockerfile } from '#runner/dockerfile-renderer.js'
import { buildDockerImage } from '#runner/docker-builder.js'
import { extractFromImage } from '#runner/docker-extractor.js'
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
  _stack: AsyncDisposeStack
) {
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
    packageLoader: toValue({ loadPackages } satisfies PackageLoader),
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
    packages: toFactory(
      ['root', 'packageLoader'],
      (root: string, loader: PackageLoader) => loader.loadPackages(root)
    ),
    hostPlatform: toFactory(
      ['env'],
      (env: NodeJS.ProcessEnv): HostPlatform => hostPlatform(env)
    ),
    runner: toFactory(
      ['root', 'packages', 'dockerfileRenderer', 'dockerImageBuilder', 'hostPlatform', 'reporter'],
      (
        root: string,
        packages: ReadonlyMap<string, PackageDef>,
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
          host
        )
    ),
    listCommandRunner: toClass(['packages', 'output'], ListCommandRunner),
    runCommandRunner: toClass(
      ['runner', 'dockerImageExtractor', 'hostRoot', 'currentPackage'],
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
