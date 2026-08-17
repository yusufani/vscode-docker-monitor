import * as vscode from "vscode";
import { createCollectors } from "./collectors/factory";
import { MonitorService } from "./services/monitorService";
import { StatusBarController } from "./views/statusBar";
import { GpuSidebarProvider } from "./views/gpuSidebar";
import { ContainerTableViewProvider } from "./views/containerTableView";
import { GpuMonitorPanel } from "./views/webview/gpuMonitorPanel";
import { ProcessItem, ProcessDetailItem, ContainerItem, RamProcessItem, CpuProcessItem, RamManagerItem, CpuManagerItem, DiskManagerItem } from "./views/treeItems";
import { fmtMem, fmtUptime, fmtStartDate } from "./utils/format";
import { execCommand, findBinary } from "./utils/exec";
import { describeStatus, formatReport, shouldWarnAboutK8s } from "./collectors/kubernetesDiagnostics";
import { getOutputChannel, log } from "./utils/logger";
import { initHostProcHelper, sweepHostProcLeftovers } from "./utils/hostProcHelper";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = getOutputChannel();
  context.subscriptions.push(outputChannel);
  log("Extension activating...");
  log(`platform = ${process.platform}, cwd = ${process.cwd()}`);

  // ── Host /proc helper: persisted consent + clean up stranded containers ───────
  initHostProcHelper(context);
  void findBinary("docker").then((docker) => {
    if (docker) return sweepHostProcLeftovers(docker);
  });

  // ── Create collectors (platform-aware) ────────────────────────
  const collectors = await createCollectors();

  // ── MonitorService (single refresh loop) ──────────────────────
  const monitor = new MonitorService(collectors.system, collectors.gpu, collectors.docker, collectors.k8s);
  context.subscriptions.push(monitor);

  // ── Kubernetes diagnostics ────────────────────────────────────
  registerK8sDiagnostics(context, monitor);

  // ── Container Resources table (webview sidebar) ───────────────
  const containerTable = new ContainerTableViewProvider(monitor);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ContainerTableViewProvider.viewType, containerTable),
    containerTable,
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dockerServices.refresh", () => monitor.refresh()),
  );

  // ── GPU / System Monitor sidebar ──────────────────────────────
  const gpuSidebar = new GpuSidebarProvider(monitor);
  const gpuSidebarView = vscode.window.createTreeView("gpuMonitor", { treeDataProvider: gpuSidebar });
  context.subscriptions.push(gpuSidebarView, gpuSidebar);

  // Collect RAM / disk breakdowns only while their sections are expanded (saves CPU/du cost)
  context.subscriptions.push(
    gpuSidebarView.onDidExpandElement((e) => {
      if (e.element instanceof RamManagerItem) monitor.setRamWanted(true);
      else if (e.element instanceof CpuManagerItem) monitor.setCpuWanted(true);
      else if (e.element instanceof DiskManagerItem) monitor.setDiskWanted(true);
    }),
    gpuSidebarView.onDidCollapseElement((e) => {
      if (e.element instanceof RamManagerItem) monitor.setRamWanted(false);
      else if (e.element instanceof CpuManagerItem) monitor.setCpuWanted(false);
      else if (e.element instanceof DiskManagerItem) monitor.setDiskWanted(false);
    }),
  );

  // ── Status bar ────────────────────────────────────────────────
  const statusBar = new StatusBarController(monitor);
  context.subscriptions.push(statusBar);

  // Start monitoring
  monitor.startAutoRefresh();

  // ── WebView panel ─────────────────────────────────────────────
  const gpuPanel = new GpuMonitorPanel(monitor);
  context.subscriptions.push(gpuPanel);

  context.subscriptions.push(
    vscode.commands.registerCommand("gpuMonitor.show", () => gpuPanel.show()),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gpuMonitor.support", async () => {
      const options = [
        { label: "$(heart) GitHub Sponsors", url: "https://github.com/sponsors/yusufani" },
        { label: "$(credit-card) PayPal", url: "https://paypal.me/yusufani" },
      ];
      const picked = await vscode.window.showQuickPick(options, {
        placeHolder: "Support DevPulse — thank you! ❤",
      });
      if (picked) {
        await vscode.env.openExternal(vscode.Uri.parse(picked.url));
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gpuMonitor.refresh", () => {
      monitor.refresh();
    }),
  );

  // ── Kill / Stop commands ──────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("gpuMonitor.killProcess", async (item: ProcessItem) => {
      if (!(item instanceof ProcessItem)) return;
      const p = item.proc;
      if (
        (await vscode.window.showWarningMessage(
          `Kill PID ${p.pid} (${p.processName}, ${p.memMib}M VRAM)?`,
          { modal: true },
          "Kill",
        )) === "Kill"
      ) {
        try {
          await monitor.killProcess(p.pid);
          vscode.window.showInformationMessage(`Killed PID ${p.pid}`);
          monitor.refresh();
        } catch (e) {
          vscode.window.showErrorMessage(`${e}`);
        }
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gpuMonitor.killHostProcess", async (item: RamProcessItem | CpuProcessItem) => {
      if (!(item instanceof RamProcessItem) && !(item instanceof CpuProcessItem)) return;
      const p = item.proc;
      if (!p.pid) return;
      if (
        (await vscode.window.showWarningMessage(
          `Kill PID ${p.pid} (${p.comm}, ${fmtMem(p.rssMib)} RAM, user ${p.username})?`,
          { modal: true },
          "Kill",
        )) === "Kill"
      ) {
        try {
          await monitor.killProcess(p.pid);
          vscode.window.showInformationMessage(`Killed PID ${p.pid}`);
          monitor.refresh();
        } catch (e) {
          vscode.window.showErrorMessage(`${e}`);
        }
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gpuMonitor.stopContainer", async (item: ContainerItem) => {
      if (!(item instanceof ContainerItem)) return;
      const c = item.container;
      const isK8s = c.source === "k8s";
      const scalable = isK8s && ["Deployment", "StatefulSet"].includes(c.controllerKind || "");
      const prompt = isK8s
        ? scalable
          ? `Scale ${c.controllerKind} ${c.controllerName} to 0 replicas? (stops pod ${c.name})`
          : `Delete pod ${c.name}? It will be recreated by its controller if managed.`
        : `Stop container ${c.name}?`;
      const action = isK8s ? (scalable ? "Scale to 0" : "Delete Pod") : "Stop";
      if ((await vscode.window.showWarningMessage(prompt, { modal: true }, action)) === action) {
        try {
          await monitor.stopContainer(c.id);
          vscode.window.showInformationMessage(isK8s ? `Stopped pod ${c.name}` : `Stopped ${c.name}`);
          monitor.refresh();
        } catch (e) {
          vscode.window.showErrorMessage(`${e}`);
        }
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gpuMonitor.killContainer", async (item: ContainerItem) => {
      if (!(item instanceof ContainerItem)) return;
      const c = item.container;
      const isK8s = c.source === "k8s";
      const prompt = isK8s
        ? `Force-delete pod ${c.name} (--grace-period=0 --force)? Data loss possible.`
        : `Force kill ${c.name}? Data loss possible.`;
      if ((await vscode.window.showWarningMessage(prompt, { modal: true }, "Force Kill")) === "Force Kill") {
        try {
          await monitor.killContainer(c.id);
          vscode.window.showInformationMessage(`Killed ${c.name}`);
          monitor.refresh();
        } catch (e) {
          vscode.window.showErrorMessage(`${e}`);
        }
      }
    }),
  );

  // ── Restart container ────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("gpuMonitor.restartContainer", async (item: ContainerItem) => {
      if (!(item instanceof ContainerItem)) return;
      const c = item.container;
      const isK8s = c.source === "k8s";
      const managed = isK8s && ["Deployment", "StatefulSet", "DaemonSet"].includes(c.controllerKind || "");
      const prompt = isK8s
        ? managed
          ? `Rollout restart ${c.controllerKind} ${c.controllerName} (namespace ${c.namespace})?`
          : `Delete pod ${c.name} to restart it? (unmanaged pod — won't be recreated)`
        : `Restart container ${c.name}?`;
      const action = isK8s && !managed ? "Delete Pod" : "Restart";
      if ((await vscode.window.showWarningMessage(prompt, { modal: true }, action)) === action) {
        try {
          await monitor.restartContainer(c.id);
          vscode.window.showInformationMessage(`Restarted ${c.name}`);
          monitor.refresh();
        } catch (e) {
          vscode.window.showErrorMessage(`${e}`);
        }
      }
    }),
  );

  // Build a runtime-appropriate logs/exec/attach command for the given container/pod.
  const podParts = (id: string) => {
    // id = "k8s:<ns>/<name>"
    const rest = id.slice(4);
    const slash = rest.indexOf("/");
    return { ns: rest.substring(0, slash), name: rest.substring(slash + 1) };
  };
  const kubectlBin = () => vscode.workspace.getConfiguration("dockerMonitor").get<string>("kubectlBinary", "") || "kubectl";

  // Fetch the container names of a pod (for multi-container exec/logs pickers).
  const podContainers = async (ns: string, name: string): Promise<string[]> => {
    try {
      const { stdout } = await execCommand(
        `${kubectlBin()} get pod ${name} -n ${ns} -o jsonpath='{.spec.containers[*].name}' --request-timeout=6s`,
        { timeout: 9000 },
      );
      return stdout.trim().replace(/'/g, "").split(/\s+/).filter(Boolean);
    } catch {
      return [];
    }
  };
  // If a pod has more than one container, ask which one; otherwise return the only/none.
  const pickContainer = async (ns: string, name: string, action: string): Promise<string | undefined | null> => {
    const containers = await podContainers(ns, name);
    if (containers.length <= 1) return containers[0] ?? "";
    const picked = await vscode.window.showQuickPick(containers, { placeHolder: `Container to ${action} in ${name}` });
    return picked === undefined ? null : picked; // null = user cancelled
  };

  // ── Container logs ──────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("gpuMonitor.showContainerLogs", async (item: ContainerItem) => {
      if (!(item instanceof ContainerItem)) return;
      const c = item.container;
      if (c.source === "k8s") {
        const { ns, name } = podParts(c.id);
        const containers = await podContainers(ns, name);
        let cFlag = "--all-containers";
        if (containers.length > 1) {
          const picked = await vscode.window.showQuickPick(["All containers", ...containers], { placeHolder: `Logs for ${name}` });
          if (picked === undefined) return;
          cFlag = picked === "All containers" ? "--all-containers" : `-c ${picked}`;
        }
        const terminal = vscode.window.createTerminal(`Logs: ${c.name}`);
        terminal.sendText(`${kubectlBin()} logs -f --tail 100 -n ${ns} ${name} ${cFlag}`);
        terminal.show();
      } else {
        const terminal = vscode.window.createTerminal(`Logs: ${c.name}`);
        terminal.sendText(`docker logs -f --tail 100 ${c.id}`);
        terminal.show();
      }
    }),
  );

  // ── Exec into container ────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("gpuMonitor.execContainer", async (itemOrId: ContainerItem | string, nameArg?: string) => {
      let containerId: string;
      let containerName: string;
      let source: "docker" | "k8s" = "docker";
      if (itemOrId instanceof ContainerItem) {
        containerId = itemOrId.container.id;
        containerName = itemOrId.container.name;
        source = itemOrId.container.source === "k8s" ? "k8s" : "docker";
      } else if (typeof itemOrId === "string") {
        containerId = itemOrId;
        containerName = nameArg || itemOrId;
        source = containerId.startsWith("k8s:") ? "k8s" : "docker";
      } else {
        return;
      }
      if (source === "k8s") {
        const { ns, name } = podParts(containerId);
        const c = await pickContainer(ns, name, "exec");
        if (c === null) return; // cancelled
        const cFlag = c ? ` -c ${c}` : "";
        const terminal = vscode.window.createTerminal(`Exec: ${containerName}`);
        terminal.sendText(`${kubectlBin()} exec -it -n ${ns} ${name}${cFlag} -- /bin/bash || ${kubectlBin()} exec -it -n ${ns} ${name}${cFlag} -- /bin/sh`);
        terminal.show();
      } else {
        const terminal = vscode.window.createTerminal(`Exec: ${containerName}`);
        terminal.sendText(`docker exec -it ${containerId} /bin/bash || docker exec -it ${containerId} /bin/sh`);
        terminal.show();
      }
    }),
  );

  // ── Attach to container (docker only — no kubectl equivalent) ───
  context.subscriptions.push(
    vscode.commands.registerCommand("gpuMonitor.attachContainer", async (itemOrId: ContainerItem | string, nameArg?: string) => {
      let containerId: string;
      let containerName: string;
      if (itemOrId instanceof ContainerItem) {
        containerId = itemOrId.container.id;
        containerName = itemOrId.container.name;
      } else if (typeof itemOrId === "string") {
        containerId = itemOrId;
        containerName = nameArg || itemOrId;
      } else {
        return;
      }
      if (containerId.startsWith("k8s:")) {
        vscode.window.showInformationMessage("Attach is not available for Kubernetes pods. Use Exec or Logs instead.");
        return;
      }
      const terminal = vscode.window.createTerminal(`Attach: ${containerName}`);
      terminal.sendText(`docker attach ${containerId}`);
      terminal.show();
    }),
  );

  // ── Describe pod (Kubernetes only) ─────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("gpuMonitor.describePod", async (item: ContainerItem) => {
      if (!(item instanceof ContainerItem) || item.container.source !== "k8s") return;
      const { ns, name } = podParts(item.container.id);
      const terminal = vscode.window.createTerminal(`Describe: ${name}`);
      terminal.sendText(`${kubectlBin()} describe pod ${name} -n ${ns}`);
      terminal.show();
    }),
  );

  // ── View pod YAML in an editor ─────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("gpuMonitor.podYaml", async (item: ContainerItem) => {
      if (!(item instanceof ContainerItem) || item.container.source !== "k8s") return;
      const { ns, name } = podParts(item.container.id);
      try {
        const { stdout } = await execCommand(`${kubectlBin()} get pod ${name} -n ${ns} -o yaml --request-timeout=8s`, {
          timeout: 12000,
          maxBuffer: 16 * 1024 * 1024,
        });
        const doc = await vscode.workspace.openTextDocument({ content: stdout, language: "yaml" });
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (e) {
        vscode.window.showErrorMessage(`${e}`);
      }
    }),
  );

  // ── Edit pod live (kubectl edit) ───────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("gpuMonitor.podEdit", async (item: ContainerItem) => {
      if (!(item instanceof ContainerItem) || item.container.source !== "k8s") return;
      const c = item.container;
      const { ns, name } = podParts(c.id);
      // Prefer editing the owning controller when present (edits survive pod restarts)
      const target = c.controllerKind && c.controllerName
        ? `${c.controllerKind.toLowerCase()}/${c.controllerName}`
        : `pod/${name}`;
      const terminal = vscode.window.createTerminal(`Edit: ${name}`);
      terminal.sendText(`${kubectlBin()} edit ${target} -n ${ns}`);
      terminal.show();
    }),
  );

  // ── Pod events ─────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("gpuMonitor.podEvents", async (item: ContainerItem) => {
      if (!(item instanceof ContainerItem) || item.container.source !== "k8s") return;
      const { ns, name } = podParts(item.container.id);
      const terminal = vscode.window.createTerminal(`Events: ${name}`);
      terminal.sendText(
        `${kubectlBin()} get events -n ${ns} --field-selector involvedObject.name=${name} --sort-by=.lastTimestamp`,
      );
      terminal.show();
    }),
  );

  // ── Scale the pod's workload (start / stop / set replicas) ─────
  context.subscriptions.push(
    vscode.commands.registerCommand("gpuMonitor.scaleWorkload", async (item: ContainerItem) => {
      if (!(item instanceof ContainerItem) || item.container.source !== "k8s") return;
      const c = item.container;
      const { ns } = podParts(c.id);
      if (!c.controllerKind || !c.controllerName || !["Deployment", "StatefulSet", "ReplicaSet"].includes(c.controllerKind)) {
        vscode.window.showWarningMessage(`Scaling is not supported for ${c.controllerKind || "bare pods"}.`);
        return;
      }
      const input = await vscode.window.showInputBox({
        prompt: `Replicas for ${c.controllerKind} ${c.controllerName} (0 = stop)`,
        value: "1",
        validateInput: (v) => (/^\d+$/.test(v.trim()) ? undefined : "Enter a non-negative integer"),
      });
      if (input === undefined) return;
      const replicas = parseInt(input.trim());
      try {
        await execCommand(
          `${kubectlBin()} scale ${c.controllerKind.toLowerCase()}/${c.controllerName} --replicas=${replicas} -n ${ns} --request-timeout=15s`,
          { timeout: 20000 },
        );
        vscode.window.showInformationMessage(`Scaled ${c.controllerName} to ${replicas} replica(s)`);
        monitor.refresh();
      } catch (e) {
        vscode.window.showErrorMessage(`${e}`);
      }
    }),
  );

  // ── Copy pod namespace/name ────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("gpuMonitor.copyPodName", async (item: ContainerItem) => {
      if (!(item instanceof ContainerItem)) return;
      const c = item.container;
      const text = c.source === "k8s" ? `${c.namespace}/${c.name}` : c.name;
      await vscode.env.clipboard.writeText(text);
      vscode.window.showInformationMessage(`Copied: ${text}`);
    }),
  );

  // ── Port-forward a pod port and open it in the browser ─────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "gpuMonitor.podPortForward",
      async (podId: string, port: number, podName?: string, namespace?: string) => {
        if (!podId || !port) return;
        let ns = namespace;
        let name = podName;
        if (!ns || !name) {
          const p = podParts(podId);
          ns = ns || p.ns;
          name = name || p.name;
        }
        // Let the user pick a local port (defaults to the same as the container port)
        const input = await vscode.window.showInputBox({
          prompt: `Local port for ${ns}/${name} → pod port ${port}`,
          value: String(port),
          validateInput: (v) => (/^\d+$/.test(v.trim()) && +v > 0 && +v < 65536 ? undefined : "Enter a valid port"),
        });
        if (!input) return;
        const localPort = parseInt(input.trim());
        const terminal = vscode.window.createTerminal(`Port-forward: ${name}:${port}`);
        terminal.sendText(`${kubectlBin()} port-forward -n ${ns} pod/${name} ${localPort}:${port}`);
        terminal.show();
        const action = await vscode.window.showInformationMessage(
          `Port-forward started: localhost:${localPort} → ${ns}/${name}:${port}`,
          "Open in Browser",
        );
        if (action === "Open in Browser") {
          await vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${localPort}`));
        }
      },
    ),
  );

  // ── Copy process info ────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("gpuMonitor.copyProcessInfo", async (item: ProcessItem) => {
      if (!(item instanceof ProcessItem)) return;
      const p = item.proc;
      const parts = [p.processName, `PID ${p.pid}`, `VRAM ${fmtMem(p.memMib)}`, `G${p.gpuIndex}`];
      if (p.ramMib > 0) parts.push(`RAM ${fmtMem(p.ramMib)}`);
      parts.push(`User: ${p.username}`);
      if (p.cwd && p.cwd !== "?") parts.push(`CWD: ${p.cwd}`);
      const uptime = fmtUptime(p.startTime);
      if (uptime) parts.push(`Uptime: ${uptime}`);
      const startDate = fmtStartDate(p.startTime);
      if (startDate) parts.push(`Started: ${startDate}`);
      if (p.cmdline) parts.push(`CMD: ${p.cmdline}`);
      const text = parts.join(" | ");
      await vscode.env.clipboard.writeText(text);
      vscode.window.showInformationMessage("Copied process info");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gpuMonitor.copyDetailText", async (item: ProcessDetailItem) => {
      if (!(item instanceof ProcessDetailItem)) return;
      const text = typeof item.label === "string" ? item.label : "";
      await vscode.env.clipboard.writeText(text);
      vscode.window.showInformationMessage("Copied");
    }),
  );

  // ── Clipboard copy commands ──────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("gpuMonitor.copyContainerId", async (item: ContainerItem) => {
      if (!(item instanceof ContainerItem)) return;
      await vscode.env.clipboard.writeText(item.container.id);
      vscode.window.showInformationMessage(`Copied: ${item.container.id}`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gpuMonitor.copyContainerName", async (item: ContainerItem) => {
      if (!(item instanceof ContainerItem)) return;
      await vscode.env.clipboard.writeText(item.container.name);
      vscode.window.showInformationMessage(`Copied: ${item.container.name}`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gpuMonitor.copyContainerImage", async (item: ContainerItem) => {
      if (!(item instanceof ContainerItem)) return;
      await vscode.env.clipboard.writeText(item.container.image);
      vscode.window.showInformationMessage(`Copied: ${item.container.image}`);
    }),
  );

  // ── Open port in browser ──────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("gpuMonitor.openPort", async (item: ContainerItem) => {
      if (!(item instanceof ContainerItem)) return;
      const ports = item.container.ports;
      if (!ports) {
        vscode.window.showInformationMessage("No ports exposed.");
        return;
      }
      // Parse port mappings like "0.0.0.0:8888->8888/tcp, 0.0.0.0:6006->6006/tcp"
      const portEntries: Array<{ label: string; url: string }> = [];
      for (const chunk of ports.split(",")) {
        const match = chunk.trim().match(/(?:[\d.]+:)?(\d+)->(\d+)/);
        if (match) {
          const hostPort = match[1];
          const containerPort = match[2];
          portEntries.push({
            label: `localhost:${hostPort} -> ${containerPort}`,
            url: `http://localhost:${hostPort}`,
          });
        }
      }
      if (portEntries.length === 0) {
        vscode.window.showInformationMessage(`Ports: ${ports} (no host mappings found)`);
        return;
      }
      if (portEntries.length === 1) {
        vscode.env.openExternal(vscode.Uri.parse(portEntries[0].url));
        return;
      }
      const selected = await vscode.window.showQuickPick(
        portEntries.map((p) => ({ label: p.label, url: p.url })),
        { placeHolder: "Select port to open in browser" },
      );
      if (selected) {
        vscode.env.openExternal(vscode.Uri.parse(selected.url));
      }
    }),
  );

  // ── On-demand: Show env variables ──────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("gpuMonitor.showEnvVars", async (item: ContainerItem) => {
      if (!(item instanceof ContainerItem)) return;
      const inspect = await monitor.inspectContainer(item.container.id);
      if (inspect.env.length === 0) {
        vscode.window.showInformationMessage("No environment variables.");
        return;
      }
      const items = inspect.env.map((e) => {
        const [key, ...rest] = e.split("=");
        return { label: key, description: rest.join("=") };
      });
      vscode.window.showQuickPick(items, { placeHolder: `Env vars for ${item.container.name}` });
    }),
  );

  // ── On-demand: Show volume mounts ──────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("gpuMonitor.showVolumes", async (item: ContainerItem) => {
      if (!(item instanceof ContainerItem)) return;
      const inspect = await monitor.inspectContainer(item.container.id);
      if (inspect.mounts.length === 0) {
        vscode.window.showInformationMessage("No volume mounts.");
        return;
      }
      const items = inspect.mounts.map((m) => ({
        label: `${m.destination}`,
        description: `${m.source} (${m.mode})`,
      }));
      vscode.window.showQuickPick(items, { placeHolder: `Volumes for ${item.container.name}` });
    }),
  );

  // ── Quick pick: top GPU consumers ──────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("gpuMonitor.showTopConsumers", async () => {
      const data = monitor.getLatestData();
      const procs = data.gpuData.processes;
      if (procs.length === 0) {
        vscode.window.showInformationMessage("No GPU processes running.");
        return;
      }
      // Aggregate VRAM by container
      const byContainer = new Map<string, { name: string; vram: number; gpus: Set<number> }>();
      for (const p of procs) {
        const key = p.containerId || `host:${p.username}`;
        if (!byContainer.has(key)) {
          byContainer.set(key, { name: p.containerId ? p.containerName : `(host) ${p.username}`, vram: 0, gpus: new Set() });
        }
        const entry = byContainer.get(key)!;
        entry.vram += p.memMib;
        entry.gpus.add(p.gpuIndex);
      }
      const sorted = [...byContainer.values()].sort((a, b) => b.vram - a.vram);
      const items = sorted.map((c) => ({
        label: `$(package) ${c.name}`,
        description: `VRAM: ${c.vram >= 1024 ? (c.vram / 1024).toFixed(1) + " GB" : c.vram + " MB"} · GPU ${[...c.gpus].sort().join(",")}`,
      }));
      vscode.window.showQuickPick(items, { placeHolder: "Top GPU consumers (by VRAM)" });
    }),
  );

  // ── Quick pick: find container ──────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("gpuMonitor.findContainer", async () => {
      const containers = monitor.getContainers();
      if (containers.length === 0) {
        vscode.window.showInformationMessage("No containers running.");
        return;
      }
      const items = containers.map((c) => ({
        label: `${c.source === "k8s" ? "$(symbol-namespace)" : "$(package)"} ${c.name}`,
        description: `${c.source === "k8s" ? `☸ ${c.namespace} · ` : ""}${c.ownerName}${c.composeProject ? ` · ${c.composeProject}` : ""}${c.uptime ? ` · ${c.uptime}` : ""}`,
        containerId: c.id,
        containerName: c.name,
      }));
      const selected = await vscode.window.showQuickPick(items, { placeHolder: "Select container..." });
      if (!selected) return;
      const id = selected.containerId, name = selected.containerName;
      const isK8s = id.startsWith("k8s:");
      const actionList = [
        { label: "$(terminal) Exec", action: "exec" },
        { label: "$(output) Logs", action: "logs" },
      ];
      if (!isK8s) actionList.push({ label: "$(plug) Attach", action: "attach" });
      actionList.push({ label: "$(debug-stop) Stop", action: "stop" });
      actionList.push({ label: "$(debug-restart) Restart", action: "restart" });
      const actions = await vscode.window.showQuickPick(actionList, { placeHolder: `Action for ${name}` });
      if (!actions) return;
      if (actions.action === "exec") vscode.commands.executeCommand("gpuMonitor.execContainer", id, name);
      else if (actions.action === "logs") {
        const terminal = vscode.window.createTerminal(`Logs: ${name}`);
        if (isK8s) {
          const rest = id.slice(4); const slash = rest.indexOf("/");
          terminal.sendText(`${kubectlBin()} logs -f --tail 100 -n ${rest.substring(0, slash)} ${rest.substring(slash + 1)} --all-containers`);
        } else {
          terminal.sendText(`docker logs -f --tail 100 ${id}`);
        }
        terminal.show();
      }
      else if (actions.action === "attach") vscode.commands.executeCommand("gpuMonitor.attachContainer", id, name);
      else if (actions.action === "stop") { await monitor.stopContainer(id); monitor.refresh(); }
      else if (actions.action === "restart") { await monitor.restartContainer(id); monitor.refresh(); }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gpuMonitor.exportHistory", async () => {
      const history = monitor.getGpuHistory();
      if (history.length === 0) {
        vscode.window.showInformationMessage("No GPU history to export yet.");
        return;
      }
      const lines = ["timestamp,gpu_index,mem_used_mib,mem_total_mib,util_pct,temp_c"];
      for (const point of history) {
        const ts = new Date(point.timestamp).toISOString();
        for (const g of point.gpus) {
          lines.push(`${ts},${g.index},${g.memUsed},${g.memTotal},${g.util},${g.temp}`);
        }
      }
      const csv = lines.join("\n");
      const doc = await vscode.workspace.openTextDocument({ content: csv, language: "plaintext" });
      await vscode.window.showTextDocument(doc);
      vscode.window.showInformationMessage(`GPU history exported: ${history.length} samples, ${history[0]?.gpus.length || 0} GPU(s)`);
    }),
  );

  log("Extension activated.");
}

const K8S_TOAST_DISMISSED = "devpulse.k8sWarningDismissed";

/**
 * Kubernetes troubleshooting surface: a diagnostics command, a one-time notification,
 * and the "hide" action behind the sidebar warning row's × button.
 *
 * Everything here is gated on shouldWarnAboutK8s(), which requires an actual Kubernetes
 * footprint on the machine — a Docker-only user never gets a notification or a row.
 */
function registerK8sDiagnostics(context: vscode.ExtensionContext, monitor: MonitorService): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("gpuMonitor.k8sDiagnostics", async () => {
      // Explicitly asked for, so this always answers — including on machines with no
      // Kubernetes footprint at all, where the passive warning row stays hidden by design.
      const status = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "DevPulse: checking Kubernetes…" },
        () => monitor.checkK8s(),
      );
      if (!status) {
        vscode.window.showInformationMessage("DevPulse: Kubernetes monitoring is not wired up in this session.");
        return;
      }

      const channel = getOutputChannel();
      channel.appendLine("");
      channel.appendLine(formatReport(status));

      const showReport = (pick?: string) => {
        if (pick === "Show Report") channel.show(true);
      };
      const d = describeStatus(status);

      if (status.state === "ok") {
        showReport(
          await vscode.window.showInformationMessage(
            `Kubernetes is working — ${status.podCount} pod${status.podCount === 1 ? "" : "s"} visible (scope: ${status.scope}).`,
            "Show Report",
          ),
        );
        return;
      }
      if (status.state === "no-pods") {
        showReport(
          await vscode.window.showInformationMessage(
            "Kubernetes is reachable, but the cluster returned no pods.",
            "Show Report",
          ),
        );
        return;
      }
      if (status.state === "disabled") {
        const pick = await vscode.window.showInformationMessage(
          "DevPulse: Kubernetes monitoring is turned off.",
          "Turn On",
          "Show Report",
        );
        if (pick === "Turn On") {
          await vscode.workspace
            .getConfiguration("dockerMonitor")
            .update("kubernetes.enabled", true, vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage("DevPulse: Kubernetes monitoring enabled — reload the window to apply.");
        } else showReport(pick);
        return;
      }

      const pick = await vscode.window.showWarningMessage(
        `Kubernetes: ${d.message}`,
        { modal: false, detail: d.hint },
        "Show Report",
        "Open Settings",
      );
      if (pick === "Open Settings") {
        await vscode.commands.executeCommand("workbench.action.openSettings", "dockerMonitor.kubernetes");
      } else showReport(pick);
    }),
  );

  // Hide for good (× on the sidebar row) — flips the setting, not just this session.
  context.subscriptions.push(
    vscode.commands.registerCommand("gpuMonitor.hideK8sWarning", async () => {
      await vscode.workspace
        .getConfiguration("dockerMonitor")
        .update("kubernetes.showWarnings", false, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(
        "DevPulse: Kubernetes warnings hidden. Re-enable with the dockerMonitor.kubernetes.showWarnings setting.",
      );
    }),
  );

  // One-time notification, at most once per install unless dismissed permanently.
  let notified = false;
  context.subscriptions.push(
    monitor.onDataUpdated(async (data) => {
      if (notified) return;
      const cfg = vscode.workspace.getConfiguration("dockerMonitor");
      if (!cfg.get<boolean>("kubernetes.showWarnings", true)) return;
      if (!shouldWarnAboutK8s(data.k8s)) return;
      if (context.globalState.get<boolean>(K8S_TOAST_DISMISSED)) return;
      notified = true;

      const d = describeStatus(data.k8s);
      log(`[k8s] warning surfaced: ${data.k8s.state} — ${d.message}`);
      const pick = await vscode.window.showWarningMessage(
        `DevPulse can't show Kubernetes pods: ${d.message}`,
        "Show Diagnostics",
        "Don't Show Again",
      );
      if (pick === "Show Diagnostics") {
        await vscode.commands.executeCommand("gpuMonitor.k8sDiagnostics");
      } else if (pick === "Don't Show Again") {
        await context.globalState.update(K8S_TOAST_DISMISSED, true);
      }
    }),
  );
}

export function deactivate(): void {
  // All subscriptions are disposed by VS Code
}
