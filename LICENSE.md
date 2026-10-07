# Licences in this repository

This repository is not under a single licence. Each package carries its own
`LICENSE` file and an SPDX identifier in the `license` field of its
`package.json`; that file is authoritative for everything inside the package.

| Path | SPDX | Licence file |
|---|---|---|
| `packages/daemon` | `MIT` | [packages/daemon/LICENSE](packages/daemon/LICENSE) |
| `packages/mcp-server` | `Apache-2.0` | [packages/mcp-server/LICENSE](packages/mcp-server/LICENSE) |
| `packages/codegraph` | `Apache-2.0` | [packages/codegraph/LICENSE](packages/codegraph/LICENSE) |
| `packages/inspect-runtime` | `Apache-2.0` | [packages/inspect-runtime/LICENSE](packages/inspect-runtime/LICENSE) |
| `packages/shared` | `Apache-2.0` | [packages/shared/LICENSE](packages/shared/LICENSE) |
| `apps/desktop` | `Apache-2.0` | [apps/desktop/LICENSE](apps/desktop/LICENSE) |
| Repository-level files outside these packages (build and CI scripts, templates) | `Apache-2.0` | [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt) |

The daemon keeps the MIT licence it has been published under on npm. Apache-2.0
attribution notices are in [NOTICE](NOTICE).

## Third-party material

| Material | Where | Licence |
|---|---|---|
| Archivo font (embedded as woff2) | `apps/desktop/src/renderer/fonts.css`, `apps/desktop/src/renderer/first-run/_fonts.css`, `apps/desktop/design/_fonts.css` | OFL-1.1 — [apps/desktop/fonts-licenses/Archivo-OFL.txt](apps/desktop/fonts-licenses/Archivo-OFL.txt) |
| IBM Plex Mono font (embedded as woff2) | same files | OFL-1.1 — [apps/desktop/fonts-licenses/IBMPlexMono-OFL.txt](apps/desktop/fonts-licenses/IBMPlexMono-OFL.txt) |

npm dependencies are not vendored; each keeps its own licence.

## Contributions

Contributions are accepted under the licence of the package they change, with a
Developer Certificate of Origin sign-off — see [CONTRIBUTING.md](CONTRIBUTING.md).
