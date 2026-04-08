# APS Optimizer Web

Local web version of the APS optimizer for *From The Depths*.

It includes:

- editable board templates
- `3-Clip` and `4-Clip` solve modes
- `None`, `Rotational (90°)`, and `Rotational (180°)` symmetry
- local Node-backed solving with CryptoMiniSat support
- JSON export for solved layouts

## Project Status

This version is designed to be practical and fast for local use.

- `4-Clip` uses a dedicated periodic cutout solver
- `3-Clip` uses a hybrid periodic + repair pipeline
- CryptoMiniSat is used when available for targeted refinement work
- all solves use a fixed `15` second timeout

## Requirements

- Node.js 20+ recommended
- `cryptominisat5` optional but strongly recommended

If `cryptominisat5` is installed and available on `PATH`, the app will detect it automatically.

Homebrew example:

```bash
brew install cryptominisat
```

## Run Locally

```bash
cd "/Users/ekocher26/Documents/New project/web-app"
npm start
```

Then open:

```text
http://127.0.0.1:4173
```

## Scripts

```bash
npm start
npm run serve
npm run check
```

## Repository Notes

- Main app entry: [index.html](./index.html)
- Frontend logic: [app.js](./app.js)
- Solver backend: [solver-service.js](./solver-service.js)
- Local server: [server.js](./server.js)
- Shared circle templates: [circle-template.js](./circle-template.js)

## Original Desktop Project

The original desktop source that this app was derived from is preserved separately in:

```text
/Users/ekocher26/Documents/New project/APS-Optimizer-main
```

## License

MIT
