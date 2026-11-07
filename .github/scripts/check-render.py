#!/usr/bin/env python3
"""CI check for rendered Helm output (helm template ... > file).

usage: check-render.py <single.yaml> <labA.yaml> <labB.yaml> [...]
  - every lab render: no cluster-scoped object or object in a shared namespace may collide
    with another lab render (two attendees must install side by side);
  - lab renders: NetworkPolicies + quota present, no gateway Route, no prepull Job, no
    pods/exec for the workshop, no cluster-wide workshop grants beyond nodes/SCC/CRD read;
  - every render: no ClusterRoleBinding of the workshop SA to a built-in cluster role.
"""
import collections
import sys

import yaml

CLUSTER_SCOPED = {"ClusterRole", "ClusterRoleBinding", "Namespace", "CustomResourceDefinition",
                  "ValidatingAdmissionPolicy", "ValidatingAdmissionPolicyBinding",
                  "MutatingWebhookConfiguration", "ValidatingWebhookConfiguration",
                  "PriorityClass", "StorageClass", "SecurityContextConstraints"}
errors = []


def load(path):
    docs = [d for d in yaml.safe_load_all(open(path)) if d and "kind" in d]
    if not docs:
        errors.append(f"{path}: empty render")
    return docs


def release_ns(docs):
    for d in docs:
        if d["kind"] == "Deployment" and d["metadata"]["name"] == "workshop":
            return d["metadata"].get("namespace")
    return None


def key(doc, rel_ns):
    md = doc["metadata"]
    ns = "-" if doc["kind"] in CLUSTER_SCOPED else md.get("namespace", rel_ns)
    return doc["kind"], ns, md["name"]


single, *labs = sys.argv[1:]
renders = {p: load(p) for p in [single, *labs]}

# 1. collisions between lab releases
owners = collections.defaultdict(list)
for p in labs:
    rel = release_ns(renders[p])
    for d in renders[p]:
        owners[key(d, rel)].append(p)
for k, v in owners.items():
    if len(v) > 1:
        errors.append(f"collision {k} rendered by {v}")

# 2. lab-mode posture
for p in labs:
    docs = renders[p]
    kinds = collections.Counter(d["kind"] for d in docs)
    names = {(d["kind"], d["metadata"]["name"]) for d in docs}
    if kinds["NetworkPolicy"] < 6:
        errors.append(f"{p}: expected the lab NetworkPolicies")
    if kinds["ResourceQuota"] != 2 or kinds["LimitRange"] != 2:
        errors.append(f"{p}: expected LimitRange + ResourceQuota in both namespaces")
    if ("Route", "openshell-gateway") in names:
        errors.append(f"{p}: gateway Route must be disabled in lab mode")
    if ("Job", "sandbox-image-prepull") in names:
        errors.append(f"{p}: per-release prepull must be disabled in lab mode")
    for d in docs:
        if d["kind"] in ("Role", "ClusterRole") and "workshop" in d["metadata"]["name"]:
            for r in d.get("rules", []):
                if "pods/exec" in r.get("resources", []):
                    errors.append(f"{p}: {d['kind']} {d['metadata']['name']} grants pods/exec")
        if d["kind"] == "ClusterRole" and d["metadata"]["name"].endswith("-workshop"):
            res = sorted({x for r in d["rules"] for x in r["resources"]})
            if res != ["customresourcedefinitions", "nodes", "securitycontextconstraints"]:
                errors.append(f"{p}: workshop ClusterRole too wide: {res}")

# 3. no built-in cluster-wide grants to the workshop SA
for p, docs in renders.items():
    for d in docs:
        if d["kind"] == "ClusterRoleBinding":
            subj = {s.get("name") for s in d.get("subjects", [])}
            if "workshop" in subj and not d["roleRef"]["name"].endswith("-workshop"):
                errors.append(f"{p}: ClusterRoleBinding {d['metadata']['name']} -> {d['roleRef']['name']}")

if errors:
    print("\n".join("✗ " + e for e in errors))
    sys.exit(1)
print(f"✓ {len(renders)} renders OK ({len(labs)} lab releases, no collisions)")
