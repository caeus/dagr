# Examples

## Starter

[`starter/`](starter/) is a minimal, complete dagr setup intended to be copied into a repository.
It contains exactly the files needed to bootstrap dagr and one runnable target:

```text
starter/
├── .dagr/
│   ├── cli.sh
│   ├── dagr
│   └── install.sh
└── dagr.index.js
```

Copy the directory contents into your repository root:

```sh
cp -R examples/starter/. /path/to/your-repo/
cd /path/to/your-repo
.dagr/install.sh
export PATH="$HOME/.local/bin:$PATH"
dagr list
dagr run ci:hello
```

The three files under `.dagr/` are the repository-local runner bootstrap. `dagr.index.js` is where
your build graph starts. Replace `ci:hello` with your first real target, then split targets into
package-level `dagr.index.js` files as the repository grows.

For a larger real-world example, see [caeus/caeus.github.io](https://github.com/caeus/caeus.github.io),
which uses a root graph, shared `dagr.*` modules, generated workspace manifests, base images, and
package-level targets.

For the reasoning behind the bootstrap and the full adoption checklist, see
[Adopting dagr in a new monorepo](../docs/10-adopting-in-a-new-monorepo.md).
