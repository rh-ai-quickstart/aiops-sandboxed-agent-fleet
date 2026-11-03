# Attendee Guide — Sandboxed Agent Fleet Lab

Welcome! In this hands-on lab you build an AI agent that runs **sealed in an OpenShell sandbox** on
OpenShift, give it tools and skills under a deny-by-default policy, then run a **fleet of SRE agents**
that investigates a real incident on a live application.

Everything happens in your browser. You don't need an OpenShift account, a CLI or a GPU.

---

## 1. What you receive

Your facilitator gives you one line with:

| Item | What it is |
|---|---|
| **Workshop URL** | `https://workshop-userNN-openshell.<apps-domain>/?token=…` — your personal entry point. The token logs you in (a cookie keeps you signed in for 7 days). **Do not share it**: it is your environment. |
| **OpenClaw UI URL + password** | The Control UI of the agent you will build (used from Part IV on). |
| **Grafana URL** | Read-only dashboards (metrics, logs, traces). |

`NN` is your attendee number (for example `user07`).

---

## 2. Your environment

You have your own, isolated copy of the platform on a shared cluster:

| | |
|---|---|
| `userNN-openshell` (`$OPENSHELL_NS`) | your OpenShell gateway, your sandboxes (agents), your skill registry, the workshop |
| `userNN-demo` (`$DEMO_NS`) | the demo shop app you will break and fix in the Incident Lab |
| Model | NVIDIA **Nemotron 3 Nano** served on the cluster's GPU, OpenAI-compatible. Your API key is already registered in your gateway: your agents only ever see a placeholder, and the gateway swaps in the real key on the way out. |

The lessons use `$OPENSHELL_NS` and `$DEMO_NS` everywhere, so every command targets **your** namespaces.

---

## 3. Using the workshop

- **Lessons** are on the left, in 7 parts:
  1. **Welcome**
  2. **What's already running**: the cluster and the OpenShell gateway
  3. **How OpenShell works**: control plane, policies, a throwaway sandbox
  4. **Build your agent**: inference, create, configure, open the UI, pair, chat
  5. **Make it yours**: identity, web search, skills, heartbeat, OpenAI API
  6. **Capstone**: spin up the SRE fleet, then orchestrate and resolve an incident
  7. **Reference**: live view, observability, troubleshooting
- **Terminal:** lessons with a lab open a real shell on the right. It runs as your workshop identity,
  with `oc` and `openshell` already configured for your gateway.
- **Run in shell:** every code block has a button that runs it in your terminal. You can also type or
  paste commands.
- Do the lessons **in order**. Parts IV-VI build on each other: `shifty`, your agent, is created in
  Part IV and reused afterwards.

---

## 4. Shared-cluster rules (by design)

You share the cluster with the other attendees, so a few things are intentionally **forbidden**. If you
see `Forbidden`, that is RBAC doing its job, not a bug:

- `oc exec` into pods. Use `openshell sandbox exec -n <sandbox> -- …` to get into your agents.
- Listing or reading other attendees' namespaces, or cluster-wide `oc get pods -A` / `oc get routes -A`.
- Reaching another attendee's gateway, sandboxes or app. The network blocks it.

You **can** read nodes, SCCs and CRDs, manage your own sandboxes, and deploy, break and fix your own demo
app.

Your namespaces have a resource quota (about 10 sandboxes). Delete sandboxes you no longer need:
`openshell sandbox delete <name>`.

---

## 5. Troubleshooting

| Symptom | What to do |
|---|---|
| Terminal disconnected or frozen | Reload the page. Your sandboxes keep running. |
| `sandbox … is not ready (phase: Provisioning)` | Wait 30-60 s. The first sandbox on a node can take longer. Check with `openshell sandbox list`. |
| `openshell sandbox list` shows a sandbox `Stopped` (e.g. after a cluster restart) | `openshell sandbox start <name>` — it comes back with its files. |
| A sandbox never becomes Ready | Delete it and create it again with the lesson's command. It must include `--policy`. |
| The agent fails with `HTTP 500 "credential_unavailable"` | The facilitator rotated the model key. Re-run step 2 (**Start or restart the gateway**) of the **Configure** lesson. |
| The agent answers slowly | Everyone shares the GPU. During the Incident Lab, wait for the timeline to finish rather than clicking again. |
| `Forbidden` | Expected for the actions in §4. |
| The OpenClaw UI asks to pair | Follow the **Pair Your Browser** lesson. |
| Something is really broken | Ask your facilitator: they can rebuild your environment in a few minutes, and your URL and password stay the same. |

---

## 6. After the lab

Your environment is deleted after the event. Everything you built is described in the lessons, and the
**Resources & Links** lesson points to the OpenShell, OpenClaw and OpenShift AI docs if you want to run it
yourself (see the repository README for the single-instance deployment).
