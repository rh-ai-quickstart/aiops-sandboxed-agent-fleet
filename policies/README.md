# OpenClaw sandbox policies

Declarative policy for the OpenClaw agent running in the OpenShell sandbox. NemoClaw runs
**deny-by-default**: the agent can only reach endpoints listed here, only via the listed
binaries, and can only write to the listed filesystem paths.

## Files

| File | Purpose |
|------|---------|
| [`openclaw-sandbox.yaml`](openclaw-sandbox.yaml) | Main sandbox policy (authoring format). **Balanced** tier. |
| [`openclaw-sandbox.json`](openclaw-sandbox.json) | Same policy in JSON (for tooling / the `sandbox-policy.schema.json` validator). |
| [`presets/github.yaml`](presets/github.yaml) | Example hot-add preset. |

Keep the two main files in sync. To regenerate the JSON from the YAML:

```bash
python3 -c "import yaml,json,sys; json.dump(yaml.safe_load(open('openclaw-sandbox.yaml')), sys.stdout, indent=2)" > openclaw-sandbox.json
```

## Schema (per endpoint group)

```yaml
network_policies:
  - name: <unique id>                 # e.g. github, pypi
    endpoints:
      - host: <fqdn>
        port: <int>
        protocol: rest | websocket
        enforcement: enforce          # L7 inspect methods/paths …
        # access: full                # … OR L4 tunnel (package managers); omit rules
    binaries:                         # REQUIRED — stops exfil via curl/wget
      - /usr/bin/node
      - /usr/local/bin/node
    rules:                            # required unless access: full
      - method: GET | POST | PUT | PATCH | DELETE   # wildcard '*' is forbidden
        path: /api/**                 # glob; /** = all subpaths
```

Static, creation-locked sections (changing them recreates the sandbox):

```yaml
filesystem:
  read_write: [/sandbox, /tmp]
  read_only:  [/usr, /etc, /lib, /bin]
process:
  allowed_binaries: [/usr/bin/node, /usr/local/bin/node, /bin/bash, ...]
```

## Tiers

| Tier | Presets on top of baseline |
|------|----------------------------|
| Restricted | none (baseline only) |
| **Balanced** (this file) | npm, pypi, huggingface, brew, brave |
| Open | npm, pypi, slack, discord, telegram, jira, outlook |

Inference is not part of these files: with OpenShell 0.1.x the sandbox attaches an
inference provider (`openshell sandbox create --provider <name>`), and the provider's profile
(`manifests/openclaw/inference-profile.yaml.tmpl`, endpoint parsed from
`NEMOCLAW_INFERENCE_BASE_URL`) contributes the model endpoint to the effective policy.

The registry host is `registry.openshell.svc.cluster.local` (single-instance default). In
other namespaces (lab mode) the tooling rewrites it to
`registry.<namespace>.svc.cluster.local` — the OpenShell proxy does not resolve
single-label hosts such as `registry`.

## Applying

- **At creation (static + network):** `openshell sandbox create --policy policies/openclaw-sandbox.yaml ...`
  (a sandbox created without `--policy` never becomes Ready on 0.1.x).
- **Live, whole file:** `openshell policy set <sandbox> --policy <file> --wait`
- **Live, incremental (network only):** `openshell policy update <sandbox> --add-endpoint host:port[:access[:protocol]]`
  (L7 allow/deny rules need `--rule-name` plus `--binary ...` or `--any-binary`).
- **Ad-hoc approval:** when the agent hits an unlisted host, approve the draft rule in the
  workshop's Approvals page or `openshell term`.
