export default {
  '/package/manifest': {
    deps: {},
    run: () => ({ value: { name: 'starter', version: '1.0.0' } }),
  },
  '/file/package.json': {
    deps: { manifest: '/package/manifest' },
    run: ({ manifest }) => ({
      build: {
        FROM: 'scratch',
        steps: [{ WRITE: {
          path: '/package.json',
          content: JSON.stringify(manifest, null, 2) + '\n',
        } }],
        IGNORE: [],
        path: '/package.json',
      },
    }),
  },
  '/ci/hello': {
    deps: { manifest: '/file/package.json' },
    run: ({ manifest }) => ({
      build: {
        FROM: 'alpine:3.22',
        steps: [
          { COPY: { from: manifest.image, src: manifest.path, dest: '/package.json' } },
          { RUN: 'cat /package.json' },
        ],
        IGNORE: ['.git'],
      },
    }),
  },
}
