# OpenClaw sandbox policies

Declarative policy for the OpenClaw agent running in the OpenShell sandbox. OpenShell runs
**deny-by-default**: the agent can only reach endpoints listed here, only via the listed
binaries, and can only write to the listed filesystem paths.

## Files

| File | Purpose |
|------|---------|
| [`openclaw-sandbox.yaml`](openclaw-sandbox.yaml) | Main sandbox policy (authoring format). **Balanced** tier. |
| [`openclaw-sandbox.json`](openclaw-sandbox.json) | Same policy in JSON (for tooling / the `sandbox-policy.schema.json` validator). |
| [`presets/github.yaml`](presets/github.yaml) | Example network rule to merge into a running sandbox's policy. |
| [`presets/cluster-copilot.yaml`](presets/cluster-copilot.yaml) | Least-privilege policy for an agent that reads the cluster API. |

Keep the two main files in sync. To regenerate the JSON from the YAML:

```bash
python3 -c "import yaml,json,sys; json.dump(yaml.safe_load(open('openclaw-sandbox.yaml')), sys.stdout, indent=2)" > openclaw-sandbox.json
```

## Schema (OpenShell 0.1.x)

`network_policies` is a **map keyed by rule name**; each binary is a `{ path: ... }` object, and
L7 rules sit under their endpoint with an `allow:` wrapper:

```yaml
network_policies:
  github:                             # rule name (unique)
    name: github
    endpoints:
      - host: api.github.com
        port: 443
        protocol: rest
        enforcement: enforce          # L7: inspect methods/paths …
        rules:
          - allow: { method: GET, path: "/repos/**" }
      - host: github.com
        port: 443
        access: full                  # … OR an L4 tunnel (package managers, git); no rules
    binaries:                         # which executables may use these endpoints
      - { path: /usr/bin/node }
      - { path: /usr/local/bin/node }
```

Sections fixed at creation (an update cannot change them):

```yaml
version: 1
filesystem_policy:
  include_workdir: true
  read_only:  [/usr, /lib, /proc, /dev/urandom, /app, /etc, /var/log]
  read_write: [/sandbox, /tmp, /var/tmp, /dev/null]
landlock: { compatibility: best_effort }
process: { run_as_user: sandbox, run_as_group: sandbox }
```

Reference: the OpenShell policy schema (`docs/how-it-works/policies/schema.mdx` in
[NVIDIA/OpenShell](https://github.com/NVIDIA/OpenShell)).

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
