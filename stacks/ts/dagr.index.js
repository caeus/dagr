const STACKS_COMMIT = 'a2dc4a147afe56ca006e49f405e55cd55bdf5d15'
const DI_COMMIT = 'a8782212bc94065dff632749f884ff84022d314e'

export default {
  '/': {
    FROM: 'alpine:3.22',
    steps: [
      { RUN: 'apk add --no-cache git' },
      {
        RUN: [
          'git init /src',
          'cd /src',
          'git remote add origin https://github.com/caeus/dagr-stacks.git',
          'git sparse-checkout init --cone',
          'git sparse-checkout set typescript',
          `git fetch --depth=1 --filter=blob:none origin ${STACKS_COMMIT}`,
          'git checkout --detach FETCH_HEAD',
          `git fetch --depth=1 --filter=blob:none origin ${DI_COMMIT}`,
          'rm -f /src/typescript/di/dagr.index.js',
          `git show ${DI_COMMIT}:di/dagr.di.js > /src/typescript/di/dagr.di.js`,
          `find /src/typescript -type f -name '*.js' -exec sed -i 's#//di//#//di/#g' {} \\;`,
        ].join(' && '),
      },
      { WORKDIR: '/src/typescript' },
    ],
    IGNORE: [],
  },
}
