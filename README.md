# APS Optimizer Web

Local web version of the APS optimizer for *From The Depths*.

It includes:

- editable board templates
- `3-Clip` and `4-Clip` solve modes
- `None`, `Rotational (90°)`, and `Rotational (180°)` symmetry
- local Node-backed solving with CryptoMiniSat support

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
cd "APS-optimizer-JS"
npm start
```
Then open:

```text
http://127.0.0.1:4173
```
# Known issues:
3-clip tetris on boards larger than 25x25 may not be perfect. Trying to make it perfect is too computationally expensive, however, so this is the best it can do. 

Coded with ChatGPT Codex
