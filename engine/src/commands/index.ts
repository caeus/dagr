import { object, or } from "@optique/core/constructs";
import { multiple, withDefault } from "@optique/core/modifiers";
import { argument, command, constant, flag } from "@optique/core/primitives";
import { string } from "@optique/core/valueparser";
import type { InferValue } from "@optique/core/parser";
import { message } from "@optique/core/message";
import { run } from "@optique/run";
import { resolve } from "node:path";
import type { PackageLoader } from "#pkg/loader.js";
import { canonicalPackageName, FQT, packageLogicalPath, type Runner } from "#runner/index.js";
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
      description: message`A target as //package:facet:target; the package, or package and facet, may be omitted and taken from the working directory.`,
    }),
    { min: 1 },
  ),
}), {
  brief: message`Build targets and their dependencies, then export their outputs.`,
})
const listCommand = command('list', object({ command: constant('list') }), {
  brief: message`Print every target with its dependencies, in topological order.`,
})
const parser = or(runCommand, listCommand)

export type Cmd = InferValue<typeof parser>
export type RunCmd = InferValue<typeof runCommand>

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
      const facets = loaded.definition;
      for (const [facetName, targets] of Object.entries(facets)) {
        for (const [targetName, target] of Object.entries(targets)) {
          const fqt = new FQT(canonicalPackageName(packageName), facetName, targetName);
          const deps = target.deps.map((d) =>
            FQT.parse(d, { pkg: fqt.pkg, facet: facetName }).toString(),
          );
          graph.set(fqt.toString(), deps);
        }
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

export class RunCommandRunner {
  constructor(
    private readonly runner: Runner,
    private readonly extractor: DockerImageExtractor,
    private readonly root: string,
    private readonly currentPackage: string,
  ) {}

  async execute(cmd: RunCmd): Promise<void> {
    const context = this.currentPackage
      ? { pkg: canonicalPackageName(this.currentPackage) }
      : undefined;
    const results = await Promise.all(
      cmd.fqts.map((raw) => this.runner(FQT.parse(raw, context))),
    );

    const mountedExport = results.find(
      result => result.export && result.fqt.pkg.slice(2).includes('//'),
    );
    if (mountedExport)
      throw new Error(`Cannot EXPORT from a mounted package: ${mountedExport.fqt}`);

    for (const result of results) {
      if (result.export) {
        const packageDir = resolve(this.root, packageLogicalPath(result.fqt.pkg));
        await this.extractor.extractFromImage(
          result.imageTag,
          result.export,
          packageDir,
        );
      }
    }
  }
}

export class CompositeCommandRunner implements CommandRunner {
  constructor(
    private readonly runRunner: RunCommandRunner,
    private readonly listRunner: ListCommandRunner,
  ) {}

  execute(cmd: Cmd): Promise<void> {
    if (cmd.command === "run") return this.runRunner.execute(cmd);
    return this.listRunner.execute();
  }
}
