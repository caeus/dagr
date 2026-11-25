import { object, or } from "@optique/core/constructs";
import { multiple, withDefault } from "@optique/core/modifiers";
import { argument, command, constant, flag } from "@optique/core/primitives";
import { string } from "@optique/core/valueparser";
import type { InferValue } from "@optique/core/parser";
import { message } from "@optique/core/message";
import { run } from "@optique/run";
import { resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { PackageLoader } from "#pkg/loader.js";
import {
  canonicalPackageName,
  FQT,
  packageLogicalPath,
  relativePackageName,
  type Runner,
} from "#runner/index.js";
import type { DockerImageExtractor } from "#runner/docker-extractor.js";
const runCommand = command('run', object({
  command: constant('run'),
  verbose: withDefault(
    flag('-v', '--verbose', {
      description: message`Stream Docker output as it happens instead of only on failure.`,
    }),
    false,
  ),
  fqts: multiple(
    argument(string({ metavar: 'TARGET' }), {
      description: message`A target as //project:/node/path; omit the project to use the working directory.`,
    }),
    { min: 1 },
  ),
}), {
  brief: message`Build targets and their dependencies, then export their outputs.`,
})
const listCommand = command('list', object({ command: constant('list') }), {
  brief: message`Print every target with its dependencies, in topological order.`,
})
const pkgCommand = command('pkg', command('ls', object({ command: constant('pkg-ls') }), {
  brief: message`Print the packages in the working directory, by relative name.`,
}), {
  brief: message`Inspect the packages of the repository.`,
})
const showCommand = command('show', object({
  command: constant('show'),
  fqts: multiple(
    argument(string({ metavar: 'TARGET' }), {
      description: message`A target as //project:/node/path; omit the project to use the working directory.`,
    }),
    { min: 1 },
  ),
}), {
  brief: message`Print node dependencies as YAML, without evaluating them.`,
})
const parser = or(runCommand, listCommand, pkgCommand, showCommand)

export type Cmd = InferValue<typeof parser>
export type RunCmd = InferValue<typeof runCommand>
export type ShowCmd = InferValue<typeof showCommand>

export function parseCmd(args: string[]): Cmd {
  return run(parser, { args, programName: 'dagr', help: 'both' });
}

export interface CommandRunner {
  execute(cmd: Cmd): Promise<void>;
}

export interface Output {
  write(line: string): void;
}

export class ListCommandRunner implements CommandRunner {
  constructor(
    private readonly packageLoader: PackageLoader,
    private readonly output: Output,
  ) {}

  async execute(): Promise<void> {
    const graph = new Map<string, readonly string[]>();
    const packages = await this.packageLoader.loadAllPackages();

    for (const [packageName, loaded] of packages) {
      for (const [path, node] of Object.entries(loaded.definition)) {
        const fqt = new FQT(canonicalPackageName(packageName), path);
        graph.set(fqt.toString(), Object.values(node.deps).map(ref =>
          FQT.parse(ref, { pkg: fqt.pkg }).toString()));
      }
    }

    const sorted: string[] = [];
    const visited = new Set<string>();
    const visit = (key: string): void => {
      if (visited.has(key)) return;
      visited.add(key);
      for (const dep of graph.get(key) ?? []) {
        if (graph.has(dep)) visit(dep);
      }
      sorted.push(key);
    };
    for (const key of graph.keys()) visit(key);
    for (const key of sorted) {
      const deps = graph.get(key) ?? [];
      this.output.write(`${key}[${deps.join(", ")}]`);
    }
  }
}

export class PackageListCommandRunner implements CommandRunner {
  constructor(
    private readonly packageLoader: PackageLoader,
    private readonly output: Output,
    private readonly currentPackage: string,
  ) {}

  async execute(): Promise<void> {
    const packages = await this.packageLoader.loadAllPackages();
    const base = this.currentPackage;
    const names = [...packages.keys()]
      .map(logicalPath => relativePackageName(base, canonicalPackageName(logicalPath)))
      .filter((name): name is string => name !== undefined)
      .sort();
    for (const name of names) this.output.write(name);
  }
}

export class RunCommandRunner {
  constructor(
    private readonly runner: Runner,
    private readonly extractor: DockerImageExtractor,
    private readonly root: string,
    private readonly currentPackage: string,
  ) {}

  async execute(cmd: RunCmd): Promise<void> {
    const context = { pkg: this.currentPackage };
    const results = await Promise.all(
      cmd.fqts.map((raw) => this.runner(FQT.parse(raw, context))),
    );

    const mountedExport = results.find(
      result => result.build?.export && result.fqt.pkg.slice(2).includes('//'),
    );
    if (mountedExport)
      throw new Error(`Cannot EXPORT from a mounted package: ${mountedExport.fqt}`);

    for (const result of results) {
      if (result.build?.export) {
        const packageDir = resolve(this.root, packageLogicalPath(result.fqt.pkg));
        await this.extractor.extractFromImage(
          result.build.imageTag,
          result.build.export,
          packageDir,
        );
      }
    }
  }
}

export class ShowCommandRunner {
  constructor(
    private readonly packageLoader: PackageLoader,
    private readonly output: Output,
    private readonly currentPackage: string,
  ) {}

  async execute(cmd: ShowCmd): Promise<void> {
    const documents: string[] = [];
    for (const raw of cmd.fqts) {
      const fqt = FQT.parse(raw, { pkg: this.currentPackage });
      const loaded = await this.packageLoader.loadPackage(packageLogicalPath(fqt.pkg));
      const node = loaded?.definition[fqt.path];
      if (!node) throw new Error(`Unknown node: ${fqt}`);
      const deps = Object.fromEntries(Object.entries(node.deps).map(([id, ref]) =>
        [id, FQT.parse(ref, { pkg: fqt.pkg }).toString()]));
      documents.push(`# ${fqt}\n${stringifyYaml({ deps }, { lineWidth: 0 }).trimEnd()}`);
    }
    this.output.write(documents.join('\n---\n'));
  }
}

export class CompositeCommandRunner implements CommandRunner {
  constructor(
    private readonly runRunner: RunCommandRunner,
    private readonly listRunner: ListCommandRunner,
    private readonly packageListRunner: PackageListCommandRunner,
    private readonly showRunner: ShowCommandRunner,
  ) {}

  execute(cmd: Cmd): Promise<void> {
    if (cmd.command === "run") return this.runRunner.execute(cmd);
    if (cmd.command === "pkg-ls") return this.packageListRunner.execute();
    if (cmd.command === "show") return this.showRunner.execute(cmd);
    return this.listRunner.execute();
  }
}
