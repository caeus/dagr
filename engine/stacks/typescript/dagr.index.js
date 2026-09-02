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
          'cp /stack/di/dagr.di.js /stack/di/dagr.di.features.js',
          'cp /stack/di/dagr.di.js /stack/di/dagr.di.module.js',
          'cp /stack/di/dagr.di.js /stack/di/dagr.di.stack.js',
          `sed -i 's#//di//dagr.di.js#//di/dagr.di.features.js#' /stack/dagr.features.js`,
          `sed -i 's#//di//dagr.di.js#//di/dagr.di.module.js#' /stack/dagr.module.js`,
          `sed -i 's#//di//dagr.di.js#//di/dagr.di.stack.js#' /stack/dagr.stack.js`,
          `sed -i "s#collectNamed('target', targets)#collectNamed('target', targets, ({ deps, run }) => ({ deps, run }))#" /stack/dagr.stack.js`,
        ].join(' && '),
      },
      { WORKDIR: '/stack' },
    ],
    IGNORE: [],
  },
}
