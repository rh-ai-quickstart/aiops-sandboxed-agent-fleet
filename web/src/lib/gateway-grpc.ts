import path from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { OPENSHELL_NS } from "@/lib/lab-env";

// Minimal BFF gRPC client for the OpenShell gateway's openshell.v1.OpenShell service.
// The draft-policy RPCs (GetDraftPolicy / ApproveDraftChunk / …) are called directly,
// exactly like the OpenShell console does. The in-cluster gateway runs plaintext with
// unauthenticated users allowed (it is only reachable inside its namespace), so no bearer
// token is sent.
//
// Protos are vendored in web/proto from NVIDIA/OpenShell v0.1.6 (openshell, datamodel,
// sandbox, options). The google/protobuf/* imports (descriptor, duration, struct,
// timestamp) resolve to the well-known types bundled with protobufjs, which
// @grpc/proto-loader registers before parsing.
const PROTO_DIR = path.join(process.cwd(), "proto");
const LOADER_OPTS: protoLoader.Options = {
  keepCase: false,
  longs: String, // uint64 (e.g. draftVersion) comes back as a decimal string
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTO_DIR],
};

/** Every request is scoped to the gateway's default workspace (Sandbox CRs are `default--<name>`). */
export const WORKSPACE_SCOPE = { workspace: "default" } as const;

/**
 * The gateway target in the `host:port` form grpc-js expects. Reads the contract's
 * OPENSHELL_GATEWAY_ENDPOINT (`host:port`, moved to OPENSHELL_GRPC_TARGET by server.mjs so the
 * openshell CLI does not pick it up) and also accepts a full `http://host:port` URL.
 */
export function gatewayTarget(): string {
  const raw = process.env.OPENSHELL_GRPC_TARGET
    || process.env.OPENSHELL_GATEWAY_ENDPOINT
    || process.env.OPENSHELL_GATEWAY_ENDPOINT_URL
    || `openshell.${OPENSHELL_NS}.svc.cluster.local:8080`;
  return raw.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

type ServiceCtor = new (target: string, creds: grpc.ChannelCredentials) => grpc.Client;
let serviceCtor: ServiceCtor | null = null;

function openShellService(): ServiceCtor {
  if (!serviceCtor) {
    const def = protoLoader.loadSync(path.join(PROTO_DIR, "openshell.proto"), LOADER_OPTS);
    const pkg = grpc.loadPackageDefinition(def) as unknown as { openshell: { v1: { OpenShell: ServiceCtor } } };
    serviceCtor = pkg.openshell.v1.OpenShell;
  }
  return serviceCtor;
}

type UnaryMethod = (
  request: Record<string, unknown>,
  metadata: grpc.Metadata,
  options: grpc.CallOptions,
  callback: (err: grpc.ServiceError | null, resp: unknown) => void,
) => void;

/** Call a unary openshell.v1.OpenShell method on the gateway. */
export function callGateway<T = unknown>(method: string, request: Record<string, unknown>, timeoutMs = 15000): Promise<T> {
  return new Promise((resolve, reject) => {
    let client: grpc.Client;
    try {
      const Service = openShellService();
      client = new Service(gatewayTarget(), grpc.credentials.createInsecure());
    } catch (e) {
      reject(e);
      return;
    }
    const fn = (client as unknown as Record<string, UnaryMethod | undefined>)[method];
    if (typeof fn !== "function") {
      client.close();
      reject(new Error(`unknown gateway method ${method}`));
      return;
    }
    const deadline = new Date(Date.now() + timeoutMs);
    fn.call(client, request, new grpc.Metadata(), { deadline }, (err, resp) => {
      try { client.close(); } catch { /* noop */ }
      if (err) reject(err); else resolve(resp as T);
    });
  });
}
