# CLI reference

```text
dagr run [-v|--verbose] <node> [<node>...]
dagr list
dagr pkg ls
dagr show <node> [<node>...]
dagr --help
```

## run

Evaluate requested nodes and their dependencies. Only requested builds materialize
their own `EXPORT` declarations.

```sh
dagr run //packages/web:/app/build
dagr run /app/test
dagr run ./api:/app/build
```

A local semantic path uses the working project; a relative project address is resolved
from the working project. Docker output is normally streamed to stderr only on failure;
use `--verbose` to see it throughout execution.

## list

Print the discovered node graph, with dependencies before dependants. Wildcards are
resolved against the final graph. No node's `run` is evaluated.

## pkg ls

List discovered projects relative to the working directory.

## show

Inspect one or more nodes' resolved named dependencies without evaluating nodes or
building images.

```sh
dagr show //packages/web:/app/build
```

```yaml
# //packages/web:/app/build
deps:
  manifest: //packages/web:/app/file/build/package.json
```

Exit status is nonzero on failure. Progress and diagnostics use stderr.
