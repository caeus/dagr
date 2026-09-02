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
import { Run, type FacetDef, type HostPlatform } from "#pkg/schema.js";
import {
  canonicalPackageName,
  FQT,
  packageLogicalPath,
  parseSelector,
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
const pkgCommand = command('pkg', command('ls', object({ command: constant('pkg-ls') }), {
  brief: message`Print the packages in the working directory, by relative name.`,
}), {
  brief: message`Inspect the packages of the repository.`,
})
const showCommand = command('show', object({
  command: constant('show'),
  fqts: multiple(
    argument(string({ metavar: 'TARGET' }), {
      description: message`A target as //package:facet:target; the package, or package and facet, may be omitted and taken from the working directory.`,
    }),
    { min: 1 },
  ),
}), {
  brief: message`Print the run definition of targets as YAML, without building them.`,
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

export class PackageListCommandRunner implements CommandRunner {
  constructor(
    private readonly packageLoader: PackageLoader,
    private readonly output: Output,
    private readonly currentPackage: string,
  ) {}

  async execute(): Promise<void> {
    const packages = await this.packageLoader.loadAllPackages();
    const base = canonicalPackageName(this.currentPackage || '.');
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
    const context = { pkg: canonicalPackageName(this.currentPackage || '.') };
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

export class ShowCommandRunner {
  constructor(
    private readonly packageLoader: PackageLoader,
    private readonly output: Output,
    private readonly host: HostPlatform,
    private readonly currentPackage: string,
  ) {}

  async execute(cmd: ShowCmd): Promise<void> {
    const context = { pkg: canonicalPackageName(this.currentPackage || '.') };
    const documents: string[] = [];

    for (const raw of cmd.fqts) {
      const selector = parseSelector(raw, context);
      const loaded = await this.packageLoader.loadPackage(packageLogicalPath(selector.pkg));
      if (!loaded) throw new Error(`Unknown package: ${raw}`);

      if (selector.facet === undefined) {
        documents.push(this.document(
          selector.pkg,
          Object.fromEntries(Object.entries(loaded.definition).map(([facetName, facet]) => [
            facetName,
            this.facetOutline(selector.pkg, facetName, facet),
          ])),
        ));
        continue;
      }

      const facet = loaded.definition[selector.facet];
      if (!facet) throw new Error(`Unknown facet: ${raw}`);

      if (selector.target === undefined) {
        documents.push(this.document(
          `${selector.pkg}:${selector.facet}`,
          this.facetOutline(selector.pkg, selector.facet, facet),
        ));
        continue;
      }

      const target = facet[selector.target];
      if (!target) throw new Error(`Unknown target: ${raw}`);
      const fqt = new FQT(selector.pkg, selector.facet, selector.target);
      const images = Object.fromEntries(
        target.deps.map(dep => [dep, this.resolveDep(dep, fqt.pkg, fqt.facet)]),
      );
      const parsed = Run.safeParse(target.run({ images, host: this.host }));
      if (!parsed.success)
        throw new Error(`Invalid run definition for ${fqt}: ${parsed.error.message}`);

      documents.push(this.document(fqt.toString(), parsed.data));
    }

    this.output.write(documents.join('\n---\n'));
  }

  private facetOutline(
    pkg: string,
    facetName: string,
    facet: FacetDef,
  ): Record<string, readonly string[]> {
    return Object.fromEntries(Object.entries(facet).map(([targetName, target]) => [
      targetName,
      target.deps.map(dep => this.resolveDep(dep, pkg, facetName)),
    ]));
  }

  private resolveDep(dep: string, pkg: string, facet: string): string {
    return FQT.parse(dep, { pkg, facet }).toString();
  }

  private document(label: string, value: unknown): string {
    // Recipes carry long shell commands; folding them across lines makes one command read as two.
    return `# ${label}\n${stringifyYaml(value, { lineWidth: 0 }).trimEnd()}`;
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
