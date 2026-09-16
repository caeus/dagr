export default {
  ci: {
    hello: {
      deps: [],
      run: () => ({
        FROM: 'alpine:3.22',
        steps: [{ RUN: 'echo "hello from dagr"' }],
        IGNORE: ['.git'],
      }),
    },
  },
}
