import * as vscode from "vscode";
import { detectPlatform } from "../utils/platform";
import { log } from "../utils/logger";
import { ISystemCollector, IGpuCollector, IContainerCollector } from "./interfaces";
import { LinuxSystemCollector } from "./linuxSystem";
import { DarwinSystemCollector } from "./darwinSystem";
import { NvidiaCollector } from "./nvidiaCollector";
import { RocmCollector } from "./rocmCollector";
import { AppleGpuCollector } from "./appleGpuCollector";
import { NullGpuCollector } from "./nullGpuCollector";
import { DockerCollector } from "./dockerCollector";
import { KubernetesCollector } from "./kubernetesCollector";
import { ContainerAggregator } from "./containerAggregator";

export interface Collectors {
  system: ISystemCollector;
  gpu: IGpuCollector;
  /** Aggregated container/pod source (Docker + Kubernetes). */
  docker: IContainerCollector;
  /**
   * The Kubernetes collector itself, kept even when it is unavailable so the UI can
   * ask it *why* pods are missing instead of silently showing nothing.
   */
  k8s: KubernetesCollector;
}

export async function createCollectors(): Promise<Collectors> {
  const platform = detectPlatform();
  log(`Creating collectors for platform: ${platform}`);

  // System collector
  const system: ISystemCollector = platform === "darwin" ? new DarwinSystemCollector() : new LinuxSystemCollector();

  // GPU collector — probe in order: nvidia, rocm, apple, null
  let gpu: IGpuCollector;
  const nvidia = new NvidiaCollector();
  if (await nvidia.isAvailable()) {
    gpu = nvidia;
    log("GPU collector: NVIDIA");
  } else {
    const rocm = new RocmCollector();
    if (await rocm.isAvailable()) {
      gpu = rocm;
      log("GPU collector: ROCm (AMD)");
    } else if (platform === "darwin") {
      const apple = new AppleGpuCollector();
      if (await apple.isAvailable()) {
        gpu = apple;
        log("GPU collector: Apple");
      } else {
        gpu = new NullGpuCollector();
        log("GPU collector: None");
      }
    } else {
      gpu = new NullGpuCollector();
      log("GPU collector: None");
    }
  }

  // Container sources — Docker and/or Kubernetes, aggregated into one
  const cfg = vscode.workspace.getConfiguration("dockerMonitor");
  const sources: IContainerCollector[] = [];

  const docker = new DockerCollector();
  if (await docker.isAvailable()) {
    sources.push(docker);
    log("Container source: Docker");
  }

  // Always constructed — when unavailable it still answers getStatus() so the sidebar
  // can explain the reason (missing kubectl, unreachable cluster, over-tight scope…).
  const k8s = new KubernetesCollector({
    enabled: cfg.get<boolean>("kubernetes.enabled", true),
    scope: cfg.get<"node" | "cluster">("kubernetes.scope", "node"),
    namespaces: cfg.get<string[]>("kubernetes.namespaces", []),
    kubectlBinary: cfg.get<string>("kubectlBinary", ""),
  });
  if (cfg.get<boolean>("kubernetes.enabled", true)) {
    // Registered even if the first probe fails: every call re-checks isAvailable()
    // (60s cache) and returns empty until the cluster becomes reachable, so a kubeconfig
    // added after startup starts working without reloading the window.
    sources.push(k8s);
    try {
      const up = await k8s.isAvailable();
      log(
        up
          ? `Container source: Kubernetes (scope=${cfg.get("kubernetes.scope", "node")})`
          : `Kubernetes registered but not reachable yet: ${k8s.getStatus().state}`,
      );
    } catch (e) {
      log(`Kubernetes probe failed: ${e}`);
    }
  }

  log(`Container sources active: ${sources.length}`);
  const containers = new ContainerAggregator(sources);

  return { system, gpu, docker: containers, k8s };
}
