const mounts = {
  'github.com/caeus/dagr-stacks/typescript': {
    FROM: 'ghcr.io/caeus/dagr-stacks-typescript:336d7700027c096cc8ce79e4fac5fd93154e645f',
    steps: [],
    IGNORE: [],
  },
  'github.com/caeus/dagr-stacks/di': {
    FROM: 'ghcr.io/caeus/dagr-stacks-di:7de90f567348a68cdbff0968757d7f49096b1aab',
    steps: [],
    IGNORE: [],
  },
}

export const mount = id => mounts[id]
