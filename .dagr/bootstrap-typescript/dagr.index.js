// Compatibility input for the previously released engine pinned by cli.sh.
// Current engines discover dagr.mount.yaml from the working tree instead.
export default {
  '/': {
    FROM: 'ghcr.io/caeus/dagr-stacks-typescript:336d7700027c096cc8ce79e4fac5fd93154e645f',
    steps: [],
    IGNORE: [],
  },
}
