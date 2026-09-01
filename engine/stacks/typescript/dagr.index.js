export default {
  '/': {
    FROM: 'alpine:3.22',
    steps: [
      {
        COPY: {
          from: 'ghcr.io/caeus/dagr-stacks-typescript:336d7700027c096cc8ce79e4fac5fd93154e645f',
          src: '/stack',
          dest: '/stack',
        },
      },
      {
        COPY: {
          from: 'ghcr.io/caeus/dagr-stacks-di:7de90f567348a68cdbff0968757d7f49096b1aab',
          src: '/stack',
          dest: '/stack/di',
        },
      },
      {
        RUN: [
          'rm -f /stack/di/dagr.index.js',
          `find /stack -type f -name '*.js' -exec sed -i 's#//di//#//di/#g' {} \\;`,
        ].join(' && '),
      },
      { WORKDIR: '/stack' },
    ],
    IGNORE: [],
  },
}
