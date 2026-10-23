# Experimental read-only Hex Graph SDK — DEV-001 foundation

This package is the first isolated, non-mutating slice of G-271 (Developer Platform).
It reuses `@hex-neural/protocol` rather than duplicating the six-face/semantic
connection validator. The typed API accepts untrusted `unknown` or JSON text and
returns a structured verdict; the CLI returns exit code 0 for valid, 1 for invalid,
and 2 for usage/read failures.

```sh
npm install
npm run build
node packages/sdk/bin/hex-graph.mjs validate examples/two-cell-flow.json
```

Supported protocol: HNAP v0.1 only. No auto-migrations, graph execution, network,
authentication, tool invocation, publishing, signing, or privilege escalation.
This facade is **not** a complete schema/security certification; future DEV-001..015
work must add canonical schema validation, API compatibility, permissions,
TypeScript/Python SDK transports, mock host, extension signing, and CI fixtures.
A `valid: true` core-graph result is never authorization to run a graph.
