.PHONY: all build bundlecheck test typecheck clean

all: test

build:
	pnpm exec tsc -p tsconfig.build.json
	mkdir -p dist
	pnpm exec esbuild build/index.js --bundle --platform=node --format=esm --target=node22 \
		--banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
		--outfile=dist/dagr.js

bundlecheck: build
	mkdir -p /tmp/dagr-smoke/packages
	HOST_OS=linux HOST_ARCH=x64 HOST_LIBC=glibc REPO_ROOT=/tmp/dagr-smoke \
		node --experimental-vm-modules dist/dagr.js list > /dev/null
	rm -rf /tmp/dagr-smoke

# Tests stay TypeScript and are never compiled, but #* resolves to ./build/*, so they exercise the
# same compiled modules dagr runs from source before bundling. A wrong import map fails here.
test: build
	node --experimental-vm-modules --enable-source-maps --import tsx/esm --test --test-reporter=spec 'src/**/*.test.ts'

typecheck:
	pnpm exec tsc --noEmit

clean:
	rm -rf build dist
