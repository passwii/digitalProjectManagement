# Node 26 Frontend Runtime Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Upgrade the web CI and container runtime in PR #193 from Node 20 to Node 26, verify the deployed image path, then merge and perform the requested manual deployment.

**Architecture:** Keep the upgrade scoped to the Next.js web runtime. Align GitHub Actions, production and local Docker images, and repository instructions on Node 26; leave the Python API runtime and business code unchanged. Push a new commit to PR #193, wait for its current-head CI and review, squash merge, then use the repository's manual VPS deployment script once.

**Tech Stack:** Node.js 26 LTS, Next.js 14.2.18, npm, GitHub Actions, Docker Alpine, Docker Compose, Python deployment script.

## Global Constraints

- Frontend CI, local container development, and production web images use Node 26.
- The API remains on Python 3.14; do not change its image or dependencies.
- Preserve `package-lock.json`; use `npm ci` for clean dependency installation.
- Do not deploy from the feature branch or wait on Vercel; deployment happens once after merge through `scripts/deploy_vps.py`.
- Merge PR #193 only after current-head `web · 测试` and `api · 测试` succeed and the required review is clean; the API Dockerfile comment triggers its path-filtered workflow. Use squash merge.

---

## Tasks

### Task 1: Align frontend Node versions and documentation

**Files:** Modify `.github/workflows/web.yml`, `docker/web.Dockerfile`, `docker-compose.local.yml`, `docker/api.Dockerfile` comments, `AGENTS.md`, `TESTING.md`, and the Node-version rationale in `web/lib/buttonClassTokens.test.ts`.

- [x] Set `actions/setup-node` to `node-version: "26"` and update its Docker alignment comment.
- [x] Change the web Docker builder and runner base images and local web container image from `node:20-alpine` to `node:26-alpine`.
- [x] Update the API Dockerfile comment only; keep its `python:3.14-slim` base image unchanged.
- [x] Update repository CI/local runtime documentation to Node 26 and retain the Python 3.14 instructions.
- [x] Update the test comment that describes the CI Node version; preserve historical measurements that explicitly describe Node 20.

### Task 2: Verify Node 26 locally

**Files:** Modify `web/package.json` test command only; no application behavior changes.

- [x] Change `test:unit` from the Node 20 directory argument to a quoted Node 26 recursive glob: `node --test ".test-dist/lib/**/*.test.js"`.
- [x] Confirm the active runtime is Node 26 and run `cd web && npm ci` without changing the lockfile.
- [x] Run `cd web && npm test` and report the node:test and Vitest counts.
- [x] Run `cd web && npm run build` and confirm static page generation completes.
- [ ] Run `docker build -f docker/web.Dockerfile -t pm-web:node26-check .` and inspect it with `docker image inspect pm-web:node26-check --format='user={{.Config.User}} cmd={{json .Config.Cmd}}'`.
- [x] Run `git diff --check` and review the version references to confirm only the web runtime changed.

Local Docker build status: the configured OrbStack daemon is not running at `/Users/damon/.orbstack/run/docker.sock`. If it remains unavailable, leave the image-build checkbox open and use the post-merge VPS Compose build and health checks as the deployment verification; do not claim a local image build passed.

### Task 3: Update and deliver PR #193

**Files:** Modify PR #193 description and add this plan to `docs/superpowers/plans/`.

- [ ] Commit the Node 26 runtime and documentation changes with the repository's Chinese Conventional Commit format; push the existing PR branch.
- [ ] Update PR #193 with Node 26 verification results and confirm both checks correspond to the new HEAD SHA.
- [ ] Review the current-head PR summary, reviews, inline comments, and conversation; merge only when the required review is clean and both CI checks pass.
- [ ] Squash merge PR #193, then execute `python3 scripts/deploy_vps.py` once and confirm the deployment result.
