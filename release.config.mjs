/**
 * semantic-release configuration.
 *
 * Conventional Commit messages determine the next version:
 * feat -> minor, fix -> patch, and BREAKING CHANGE -> major.
 * The npm plugin publishes the package and the GitHub plugin creates the
 * corresponding GitHub release and release notes.
 *
 * @type {import('semantic-release').GlobalConfig}
 */
export default {
  branches: ['master'],
  repositoryUrl: 'https://github.com/JasonLandbridge/pi-omniroute-sync.git',
  tagFormat: 'v${version}',
  plugins: [
    [
      '@semantic-release/commit-analyzer',
      {
        preset: 'angular',
        releaseRules: [
          { type: 'docs', scope: 'README', release: 'patch' },
          { type: 'refactor', release: 'patch' },
          { type: 'style', release: 'patch' },
        ],
        parserOpts: {
          noteKeywords: ['BREAKING CHANGE', 'BREAKING CHANGES'],
        },
      },
    ],
    [
      '@semantic-release/release-notes-generator',
      {
        preset: 'angular',
        writerOpts: {
          commitsSort: ['subject', 'scope'],
        },
      },
    ],
    [
      './node_modules/@semantic-release/npm',
      {
        npmPublish: true,
      },
    ],
    [
      '@semantic-release/github',
      {
        successCommentCondition: false,
        failCommentCondition: false,
      },
    ],
  ],
};
