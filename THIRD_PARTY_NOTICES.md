# Third-party notices

Agent Driver's original code is licensed under Apache-2.0. Dependencies keep their own licenses; this repository's license does not replace them.

The public source export does not vendor `node_modules`, browser binaries, VM images, or model weights. `npm ci` installs the exact dependency versions recorded in `package-lock.json`, including their upstream license files. Preserve those notices when redistributing an installation or a bundled build.

## Direct public-package dependencies

This inventory was checked against the installed package metadata and lockfile on 2026-09-23. It is not a replacement for the license text shipped by each package.

| Package | Version | License | Upstream |
|---|---|---|---|
| `@lydell/node-pty` | `1.2.0-beta.15` | MIT | [node-pty](https://github.com/lydell/node-pty) |
| `@modelcontextprotocol/sdk` | `1.30.0` | MIT | [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) |
| `@typesafe-ai/sdk` | `0.6.0` | MIT | [TypeSafe](https://typesafe.ai/) |
| `playwright` | `1.63.0` | Apache-2.0 | [Playwright](https://github.com/microsoft/playwright) |
| `yaml` | `2.9.1` | ISC | [yaml](https://github.com/eemeli/yaml) |
| `zod` | `4.4.3` | MIT | [Zod](https://github.com/colinhacks/zod) |

Build and test tooling: `typescript` `7.0.2` (Apache-2.0), `@types/node` `22.20.3` (MIT).

## Separately installed software and services

- Node.js, Chromium and its components, QEMU/KVM, Linux distributions, VNC tools, and external agent clients retain their own licenses. They are not relicensed by Agent Driver.
- Browser installations can contain additional notices. Redistribution of a browser, VM image, container, or appliance needs its own complete dependency inventory.
- Jev and LLM APIs are connected services, not model code or model weights included in this repository. API credentials and provider subscriptions are not included.
- Documentation may link to third-party research and services. Such links do not transfer ownership of their content or imply endorsement.
- `docs/assets/validation/contact-draft.png` depicts the Browserbase public contact page as an execution record. Website content, logos, and trademarks remain their respective owners' property; the screenshot does not imply endorsement or relicense those elements.

For the public source package, the lockfile is the exact version inventory. Before redistributing a bundled binary or hosted appliance, inspect the installed transitive dependencies and preserve the applicable notices as well.
