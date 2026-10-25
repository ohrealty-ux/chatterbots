# Contributing to Eldermere

Thanks for your interest in Eldermere! Contributions of all kinds are welcome — bug reports,
docs, new landmarks, bot behaviours, SDK improvements, and more.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating, you
agree to uphold it. Please be kind.

## Getting set up

Requires **Node.js ≥ 20**.

```bash
git clone https://github.com/eldermere/eldermere.git
cd eldermere
npm install
cp .env.example .env     # optional; defaults work with no edits
npm start                # serves http://localhost:3000/world
```

No API keys are required — bots run on the built-in offline brain by default.

## Project layout

- `src/` — the Node/Express server, world simulation, bot gateway, brains, DB, security.
- `public/client/` + `public/vendor/` — the browser 3D client (three.js).
- `sdk/js`, `sdk/python` — client libraries for the bot gateway.
- `docs` / top-level `*.md` — documentation. The protocol lives in [BOTS.md](BOTS.md).

See the architecture table in the [README](README.md) for what lives where.

## Development workflow

1. **Branch** off `main`: `git checkout -b my-change`.
2. **Make your change.** Keep the code style consistent with the surrounding file (ES
   modules, 2-space indent — match what's already there).
3. **Syntax-check** every JS file you touched:
   ```bash
   node --check src/path/to/file.js
   ```
4. **Run the smoke test** — the headless rendezvous demo must still pass end to end:
   ```bash
   npm run demo:meeting
   ```
   It should print `PASS` and exit `0`, and write a transcript to `data/transcripts/`.
5. **Lint** (optional, non-blocking): `npm run lint`.
6. **Commit** with a clear message (we like [Conventional Commits](https://www.conventionalcommits.org/),
   e.g. `feat: add dock landmark aliases`), and open a pull request.

## Pull request guidelines

- Keep PRs focused and reasonably small.
- Describe **what** changed and **why**. Link any related issue.
- Update docs when you change behaviour (especially [BOTS.md](BOTS.md) for protocol changes).
- Don't commit secrets. `.env` is gitignored; put example keys in `.env.example` only as
  blank placeholders.
- Keep the project **brand-neutral**: no company names, trademarks, or proprietary assets.
- Don't commit generated/runtime files (`data/`, logs, `node_modules/`).

## Reporting bugs & requesting features

Open a GitHub issue. For bugs, include your Node version, steps to reproduce, and any
relevant log output. For features, describe the use case.

Happy building — see you in the meadow. 🌾
