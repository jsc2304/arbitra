# Contributing

Issues and pull requests are welcome. Arbitra is published as a reference implementation without a maintenance commitment, so reviews happen when time allows.

## Issues

- **Bug**: open an issue with the bug template. Include the version (footer of the app or `CHANGELOG.md`), the steps and what you expected.
- **Idea or larger change**: open an issue or a [Discussion](https://github.com/jsc2304/arbitra/discussions) first, before writing code, so we can agree on the approach.
- **Security issue**: do not open a public issue; follow [SECURITY.md](SECURITY.md).

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Set up the local environment with the [Quick start](README.md#quick-start) (Node.js 20.19+, Docker).
3. Make a small, focused change. Follow the conventions in [AGENTS.md](AGENTS.md): TypeScript strict, Zod validation at API boundaries, colocated tests that fail when the fix is reverted.
4. Run the checks locally:

   ```bash
   npm run typecheck
   npm run lint
   npm run test
   ```

5. Open a pull request against `main` and fill in the template. Use a Conventional Commits title (`fix: …`, `feat: …`, `docs: …`).

`main` is protected: every change goes through a pull request, CI (`build-and-test`, `docker-build`) must pass, and the maintainer merges with squash. CI on pull requests from first-time contributors starts after the maintainer approves the run.

## License

By submitting a contribution you agree that it is licensed under the [Apache License 2.0](LICENSE), as stated in section 5 of the license.
