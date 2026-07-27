import { existsSync } from "fs";
import * as os from "os";
import * as path from "path";
import { K8sFootprint, K8sStatus } from "../types";
import { findBinary } from "../utils/exec";

const SA_TOKEN = "/var/run/secrets/kubernetes.io/serviceaccount/token";

/**
 * Detect whether this machine looks like it is *meant* to talk to a Kubernetes
 * cluster. Everything the warning UI shows is gated on this: a plain Docker user
 * with no kubectl and no kubeconfig has no footprint, so DevPulse stays silent
 * for them instead of nagging about a feature they never asked for.
 */
export async function probeFootprint(): Promise<K8sFootprint> {
  const kubectlPath = await findBinary("kubectl");

  // KUBECONFIG may list several paths (colon-separated); the first existing one wins.
  let kubeconfig: string | null = null;
  const envCfg = process.env.KUBECONFIG || "";
  for (const p of envCfg.split(path.delimiter)) {
    if (p && existsSync(p)) {
      kubeconfig = p;
      break;
    }
  }
  if (!kubeconfig) {
    const home = os.homedir();
    const def = path.join(home, ".kube", "config");
    if (existsSync(def)) kubeconfig = def;
  }

  const inCluster = existsSync(SA_TOKEN);

  return {
    kubectlPath,
    kubeconfig,
    inCluster,
    any: Boolean(kubectlPath || kubeconfig || inCluster),
  };
}

/**
 * Whether the UI should surface a warning for this status.
 *
 * Deliberately conservative: without a Kubernetes footprint on the machine we stay
 * completely silent, and states that are not problems ("ok", an empty cluster, or
 * monitoring the user switched off themselves) never warn either. Callers still gate
 * on the dockerMonitor.kubernetes.showWarnings setting on top of this.
 */
export function shouldWarnAboutK8s(s: K8sStatus | undefined): s is K8sStatus {
  if (!s || !s.footprint.any) return false;
  return s.state !== "ok" && s.state !== "no-pods" && s.state !== "disabled";
}

/** Short one-line reason + fix hint for each failure state (shown in the sidebar row). */
export function describeStatus(s: K8sStatus): { message: string; hint: string } {
  const f = s.footprint;
  switch (s.state) {
    case "ok":
      return { message: "Kubernetes connected", hint: "" };
    case "disabled":
      return {
        message: "Kubernetes monitoring is off",
        hint: "Enable it with the dockerMonitor.kubernetes.enabled setting.",
      };
    case "no-kubectl":
      return {
        message: "kubectl not found on PATH",
        hint: f.kubeconfig
          ? `A kubeconfig exists (${f.kubeconfig}) but kubectl is not on the extension host's PATH. ` +
            "Note that DevPulse runs commands through a non-login shell, so PATH additions made in " +
            "~/.bashrc or ~/.profile may not apply. Set an absolute path in the " +
            "dockerMonitor.kubectlBinary setting (e.g. /usr/bin/kubectl)."
          : "Install kubectl, or set an absolute path in the dockerMonitor.kubectlBinary setting.",
      };
    case "unreachable":
      return {
        message: "Cluster unreachable",
        hint: f.kubeconfig
          ? `kubectl was found but 'kubectl cluster-info' failed using ${f.kubeconfig}. ` +
            "Check that the cluster is up and the credentials in that kubeconfig are still valid."
          : "kubectl was found but no kubeconfig is readable by this user. Copy a kubeconfig to " +
            "~/.kube/config (chmod 600) or set the KUBECONFIG environment variable. A kubeconfig " +
            "belonging to a different OS user is not readable — each user needs their own copy.",
      };
    case "list-failed":
      return {
        message: "Pod list failed",
        hint: "The cluster answered but 'kubectl get pods -A' failed — most often missing RBAC " +
          "permission to list pods across namespaces. Try a namespace allow-list via the " +
          "dockerMonitor.kubernetes.namespaces setting.",
      };
    case "node-scope-empty":
      return {
        message: "Pods hidden by 'node' scope",
        hint: "The cluster returned pods, but none matched a pod cgroup on this machine, so all of " +
          "them were filtered out. This happens when the extension host cannot see the host's " +
          "cgroups or the runtime lays them out differently. Set " +
          "dockerMonitor.kubernetes.scope to 'cluster' to show all pods.",
      };
    case "no-pods":
      return { message: "No pods found", hint: "The cluster is reachable but returned no pods." };
  }
}

/** Full multi-line diagnostic report, written to the DevPulse output channel. */
export function formatReport(s: K8sStatus): string {
  const f = s.footprint;
  const yes = (v: unknown) => (v ? "yes" : "no");
  const d = describeStatus(s);

  const lines = [
    "──────────────────────────────────────────────",
    " DevPulse — Kubernetes diagnostics",
    "──────────────────────────────────────────────",
    "",
    `Status:      ${s.state}${d.message ? ` — ${d.message}` : ""}`,
    "",
    "Environment",
    `  kubectl binary:    ${f.kubectlPath || "not found (which kubectl failed)"}`,
    `  kubeconfig:        ${f.kubeconfig || "not found (~/.kube/config, $KUBECONFIG)"}`,
    `  in-cluster token:  ${yes(f.inCluster)} (${SA_TOKEN})`,
    `  scope setting:     ${s.scope}`,
    `  namespace filter:  ${s.namespaces.length ? s.namespaces.join(", ") : "(all)"}`,
    `  pods visible:      ${s.podCount}`,
    "",
  ];

  if (s.detail) {
    lines.push("Last error", ...s.detail.trim().split("\n").map((l) => `  ${l}`), "");
  }

  if (d.hint) {
    lines.push("What to do", ...wrap(d.hint, 76).map((l) => `  ${l}`), "");
  }

  lines.push(
    "Verify by hand (run these in the VS Code integrated terminal, not your own shell —",
    "the extension host may have a different PATH and environment):",
    "  which kubectl; ls -l ~/.kube/config; echo \"KUBECONFIG=$KUBECONFIG\"",
    "  kubectl cluster-info --request-timeout=4s",
    "  kubectl get pods -A --request-timeout=8s | head",
    "",
    "Turn these warnings off entirely: dockerMonitor.kubernetes.showWarnings = false",
    "Turn Kubernetes monitoring off:   dockerMonitor.kubernetes.enabled = false",
    "──────────────────────────────────────────────",
  );
  return lines.join("\n");
}

/** Naive word wrap for the report body. */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && line.length + word.length + 1 > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out;
}
