const DI_COMMIT = 'f6f8fe26837630122dc65df0026b91a32a1d53fa'

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
          'git sparse-checkout set di',
          `git fetch --depth=1 --filter=blob:none origin ${DI_COMMIT}`,
          'git checkout --detach FETCH_HEAD',
          'rm -f /src/di/dagr.di.test.js /src/di/package.json',
        ].join(' && '),
      },
      { WORKDIR: '/src/di' },
    ],
    IGNORE: [],
  },
}
