.PHONY: all build bundlecheck imagecheck test typecheck clean

all: test

build:
	pnpm exec tsc -p tsconfig.build.json
	mkdir -p dist
	pnpm exec rollup --config rollup.config.js

bundlecheck: build
	mkdir -p /tmp/dagr-smoke/packages
	HOST_OS=linux HOST_ARCH=x64 HOST_LIBC=glibc REPO_ROOT=/tmp/dagr-smoke \
		node --experimental-vm-modules dist/dagr.js list > /dev/null
	rm -rf /tmp/dagr-smoke

imagecheck: bundlecheck
	docker build --tag dagr:check .
	mkdir -p /tmp/dagr-image-smoke/packages
	docker run --rm \
		-e HOST_OS=linux -e HOST_ARCH=x64 -e HOST_LIBC=musl \
		-v /tmp/dagr-image-smoke:/repo \
		dagr:check list > /dev/null
	rm -rf /tmp/dagr-image-smoke

# Tests stay TypeScript and are never compiled, but #* resolves to ./build/*, so they exercise the
# same compiled modules dagr runs from source before bundling. A wrong import map fails here.
test: build
	node --experimental-vm-modules --enable-source-maps --import tsx/esm --test --test-reporter=spec 'src/**/*.test.ts'

typecheck:
	pnpm exec tsc --noEmit

clean:
	rm -rf build dist
