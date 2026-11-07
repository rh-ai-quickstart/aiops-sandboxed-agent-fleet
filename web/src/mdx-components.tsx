import type { MDXComponents } from "mdx/types";
import { Terminal } from "@/components/Terminal";
import { Callout } from "@/components/Callout";
import { CodeBlock } from "@/components/CodeBlock";
import { StackDiagram } from "@/components/diagrams/StackDiagram";
import { CopilotFlow } from "@/components/diagrams/CopilotFlow";
import { OpenClawArch } from "@/components/diagrams/OpenClawArch";
import { OpenShellArch } from "@/components/diagrams/OpenShellArch";
import { OpenShellRuntime } from "@/components/diagrams/OpenShellRuntime";
import { DeployTopology } from "@/components/diagrams/DeployTopology";
import { OpenShellOnK8s } from "@/components/diagrams/OpenShellOnK8s";
import { OpenShellConsole } from "@/components/diagrams/OpenShellConsole";
import { PolicyExplorer } from "@/components/diagrams/PolicyExplorer";
import { SandboxFlow } from "@/components/diagrams/SandboxFlow";
import { SecurityLayers } from "@/components/diagrams/SecurityLayers";
import { SkillSupplyChain } from "@/components/diagrams/SkillSupplyChain";
import { FleetOrchestration } from "@/components/diagrams/FleetOrchestration";
import { DemoArchitecture } from "@/components/diagrams/DemoArchitecture";
import { Orchestrator } from "@/components/Orchestrator";
import { IncidentLab } from "@/components/IncidentLab";
import { FleetView } from "@/components/FleetView";
import { LiveOpenShell } from "@/components/LiveOpenShell";
import { ServiceLink } from "@/components/ServiceLink";
import { Ns } from "@/components/LabNs";

const components: MDXComponents = {
  Terminal,
  Callout,
  StackDiagram,
  CopilotFlow,
  OpenClawArch,
  OpenShellArch,
  OpenShellRuntime,
  DeployTopology,
  OpenShellOnK8s,
  OpenShellConsole,
  PolicyExplorer,
  SandboxFlow,
  SecurityLayers,
  SkillSupplyChain,
  FleetOrchestration,
  DemoArchitecture,
  Orchestrator,
  IncidentLab,
  FleetView,
  LiveOpenShell,
  ServiceLink,
  Ns, // <Ns which="openshell" | "demo" /> — this instance's namespace in lesson prose
  pre: CodeBlock, // every fenced code block gets a Copy / Run-in-shell toolbar
};

export function useMDXComponents(): MDXComponents {
  return components;
}

export { components as mdxComponents };
