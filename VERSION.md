# Versioning Strategy

This project uses [semantic versioning](https://semver.org/) with automated release management through [semantic-release](https://github.com/semantic-release/semantic-release).

## How It Works

1. Pull request titles and commits should follow the [Conventional Commits](https://www.conventionalcommits.org/) format.
2. Merges to `main` are analyzed by semantic-release.
3. When a new version is released:
   - The version in `package.json` is updated.
   - Electron Forge packages the version from `package.json` for the macOS and Windows release makers.
   - A `CHANGELOG.md` entry is created.
   - A GitHub release is created.
   - No npm package is published because this is a private package.

## Commit Message Format

```text
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

## Release Types

- `feat`: minor version bump.
- `fix`, `perf`, `build`, `refactor`, `revert`: patch version bump.
- `chore`, `ci`, `docs`, `style`, `test`: no version bump, desktop release, or macOS/Windows CI package build.
- `BREAKING CHANGE:` in the body or footer triggers a major version bump and a desktop CI package build.

The commit type describes whether the packaged application changes. Use `build(ui)` for a new
`solutions-ui` pin and `build(deps)` for application dependency changes. Do not label either as
`chore`: `chore` is reserved for repository maintenance that cannot change the packaged app.

## Local Development

Use `bun run commit` to create properly formatted commit messages.
