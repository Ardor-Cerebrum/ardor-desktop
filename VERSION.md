# Versioning Strategy

This project uses [semantic versioning](https://semver.org/) with automated release management through [semantic-release](https://github.com/semantic-release/semantic-release).

## How It Works

1. Pull request titles and commits should follow the [Conventional Commits](https://www.conventionalcommits.org/) format.
2. Merges to `main` are analyzed by semantic-release.
3. When a new version is released:
   - The version in `package.json` is updated.
   - The Tauri versions in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock` are synchronized from `package.json`.
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
- `fix`, `perf`, `build`, `chore`, `ci`, `docs`, `style`, `refactor`, `test`, `revert`: patch version bump.
- `BREAKING CHANGE:` in the body or footer triggers a major version bump.

## Local Development

Use `bun run commit` to create properly formatted commit messages.
