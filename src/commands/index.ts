import { object, or } from "@optique/core/constructs";
import { multiple } from "@optique/core/modifiers";
import { argument, command, constant } from "@optique/core/primitives";
import { string } from "@optique/core/valueparser";
import type { InferValue } from "@optique/core/parser";
import { run } from "@optique/run";
import { resolve } from "node:path";
import type { PackageDef } from "../pkg/schema.js";
import { FQT, type Runner } from "../runner/index.js";
import type { DockerImageExtractor } from "../wire.js";
const runCommand = command('run', object({
  command: constant('run'),
  fqts: multiple(argument(string()), { min: 1 }),
}))
const listCommand = command('list', object({ command: constant('list') }))
const parser = or(runCommand, listCommand)

export type Cmd = InferValue<typeof parser>
export type RunCmd = InferValue<typeof runCommand>

export function parseCmd(args: string[]): Cmd {
  return run(parser, { args });
}

export interface CommandRunner {
  execute(cmd: Cmd): Promise<void>;
}

export class ListCommandRunner implements CommandRunner {
  constructor(private readonly packages: ReadonlyMap<string, PackageDef>) {}

  async execute(): Promise<void> {
    const graph = new Map<string, readonly string[]>();

    for (const [packageName, facets] of this.packages) {
      for (const [facetName, targets] of Object.entries(facets)) {
        for (const [targetName, target] of Object.entries(targets)) {
          const fqt = new FQT(packageName, facetName, targetName);
          const deps = target.deps.map((d) =>
            FQT.parse(d, { pkg: packageName, facet: facetName }).toString(),
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
      for (const dep of graph.get(key) ?? []) visit(dep);
      sorted.push(key);
    };
    for (const key of graph.keys()) visit(key);
    for (const key of sorted) {
      const deps = graph.get(key) ?? [];
      console.log(`${key}[${deps.join(", ")}]`);
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
      ? { pkg: this.currentPackage }
      : undefined;
    const results = await Promise.all(
      cmd.fqts.map((raw) => this.runner(FQT.parse(raw, context))),
    );

    for (const result of results) {
      if (result.export) {
        const packageDir = resolve(this.root, result.fqt.pkg);
        await this.extractor.extractFromImage(
          result.imageTag,
          result.export,
          packageDir,
        );
      }

      console.log(`Done: ${result.fqt} (${result.imageTag})`);
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
