.PHONY: all build test typecheck clean

all: test

build:
	pnpm exec tsc -p tsconfig.build.json

# Tests stay TypeScript and are never compiled, but #* resolves to ./dist/*, so they exercise the
# same compiled modules the container runs — hence the dependency on build. A wrong import map
# fails here instead of on the first real invocation.
test: build
	node --experimental-vm-modules --enable-source-maps --import tsx/esm --test --test-reporter=spec 'src/**/*.test.ts'

typecheck:
	pnpm exec tsc --noEmit

clean:
	rm -rf dist
