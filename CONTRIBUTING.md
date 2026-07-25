# Contributing to schwab-mcp

Thank you for your interest in contributing to the schwab-mcp server! This
document provides guidelines for contributing to this project.

## Table of Contents

1. [Getting Started](#getting-started)
2. [Development Workflow](#development-workflow)
3. [Commit Messages](#commit-messages)
4. [Pull Requests](#pull-requests)
5. [Deployment](#deployment)
6. [Code of Conduct](#code-of-conduct)
7. [License](#license)

## Getting Started

### Prerequisites

- Node.js 22.x
- npm
- Git
- A Cloudflare account (for local development against real bindings and for
  deploying your own instance)
- A Schwab Developer App Key and Secret from the
  [Schwab Developer Portal](https://developer.schwab.com/), for testing against
  the real Schwab API

### Setup

1. Fork the repository on GitHub
2. Clone your fork locally:<br/>
   `git clone https://github.com/your-username/schwab-mcp.git`<br/>
   `cd schwab-mcp`
3. Install dependencies: npm install
4. Add the original repository as upstream: git remote add upstream
   `https://github.com/sudowealth/schwab-mcp.git`
5. Follow the README to set up your wrangler.jsonc, KV namespace, and .dev.vars
   for local development.

## Development Workflow

### Branch Structure

- main - Main branch, tracks the latest working state
- feature/\* - Feature branches (created by contributors)
- fix/\* - Bug fix branches (created by contributors)

This project doesn't publish to npm or run automated releases, so there's no
beta branch or release-triggering branch to worry about -- every branch is just
a normal git branch.

### 1. Create a Feature/Fix Branch

Always start your work from the latest main:

```bash
git checkout main
git pull upstream main
git checkout -b feature/your-feature-name

(or)

git checkout -b fix/issue-description
```

Keep each branch scoped to a single feature or fix rather than bundling
unrelated changes together -- it makes review and, if needed, cherry-picking
individual changes into separate PRs much easier.

### 2. Implement Your Changes

Make your changes, following the code style of the project.

### 3. Run Validation

Before committing, ensure your code passes typechecking and linting:

```bash
npm run validate # Runs tsc (typecheck) and eslint (lint)
```

Also run npm run format if you've touched formatting-sensitive files, and test
your change against a real Schwab account locally with npm run dev (see the
README for local dev setup) before opening a PR -- this project talks to real
financial accounts, so a change that only typechecks isn't enough confidence on
its own.

## Commit Messages

This project uses Conventional Commits for commit messages.

### Commit Message Format

```txt
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

#### Types

- feat: A new feature
- fix: A bug fix
- docs: Documentation changes only
- chore: Maintenance tasks, no production code changes
- refactor: Code changes that neither fix bugs nor add features
- style: Changes that don't affect the code's meaning (formatting, etc.)
- perf: Performance improvements

#### Breaking Changes

For breaking changes, add BREAKING CHANGE: in the footer or append ! to the
type:

```txt
feat!: remove deprecated /sse endpoint
```

## Pull Requests

### Creating a Pull Request

#### 1. Ensure your branch is up to date with the latest main

```bash
git checkout main
git pull upstream main
git checkout your-branch-name
git rebase main
```

#### 2. Push your branch to your fork

```bash
git push origin your-branch-name
```

#### 3. Create a Pull Request on GitHub against the main branch

#### PR Guidelines

- Provide a clear title following conventional commit format
- Include a detailed description of the changes, including how you tested them
  (typecheck/lint alone isn't sufficient for anything touching auth, token
  handling, or a Schwab API call -- say how you verified it against a real
  account or a local wrangler dev session)
- Reference any related issues
- Make sure all CI checks pass
- Respond to review comments and make requested changes
- Keep PRs focused on a single change for easier review

## Deployment

Each deployment is its own Cloudflare Worker, deployed with:

```txt
npm run deploy # wrangler deploy
```

Once your PR is merged into main, anyone running their own instance picks up the
change whenever they next deploy from main -- there's no separate publish step
for maintainers to gate.

## Code of Conduct

### Our Pledge

We are committed to making participation in this project a harassment-free
experience for everyone, regardless of age, body size, disability, ethnicity,
gender identity and expression, level of experience, nationality, personal
appearance, race, religion, or sexual identity and orientation.

### Our Standards

Examples of behavior that contributes to creating a positive environment
include:

- Using welcoming and inclusive language
- Being respectful of differing viewpoints and experiences
- Gracefully accepting constructive criticism
- Focusing on what is best for the community
- Showing empathy towards other community members

### Enforcement

Instances of abusive, harassing, or otherwise unacceptable behavior may be
reported by contacting the project maintainers. All complaints will be reviewed
and investigated promptly and fairly.

## License

By contributing to this project, you agree that your contributions will be
licensed under the project's MIT license.
