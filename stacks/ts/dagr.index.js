const STACKS_COMMIT = '921919d6ec43affc2f574620292c405688e79e53'

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
          'git sparse-checkout set typescript di',
          `git fetch --depth=1 --filter=blob:none origin ${STACKS_COMMIT}`,
          'git checkout --detach FETCH_HEAD',
          'rm -f /src/typescript/di/dagr.index.js',
          'cp /src/di/dagr.di.js /src/typescript/di/dagr.di.js',
        ].join(' && '),
      },
      { WORKDIR: '/src/typescript' },
    ],
    IGNORE: [],
  },
}
