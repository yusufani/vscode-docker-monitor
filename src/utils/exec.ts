import { exec, spawn } from "child_process";
import { promisify } from "util";
import { detectPlatform } from "./platform";

const execAsync = promisify(exec);

const binaryCache = new Map<string, string | null>();

export function getShell(): string {
  return detectPlatform() === "win32" ? "cmd.exe" : "/bin/bash";
}

export async function findBinary(name: string): Promise<string | null> {
  if (binaryCache.has(name)) return binaryCache.get(name)!;

  const cmd = detectPlatform() === "win32" ? `where ${name}` : `which ${name}`;
  try {
    const { stdout } = await execAsync(cmd, { shell: getShell(), timeout: 5000 });
    const path = stdout.trim().split("\n")[0].trim();
    if (path) {
      binaryCache.set(name, path);
      return path;
    }
  } catch {
    // binary not found
  }
  binaryCache.set(name, null);
  return null;
}

export async function execCommand(
  command: string,
  options: { timeout?: number; retries?: number; maxBuffer?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const maxRetries = options.retries ?? 0;
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await execAsync(command, {
        shell: getShell(),
        timeout: options.timeout ?? 30000,
        // Default Node maxBuffer is 1 MiB; large JSON outputs (e.g. `kubectl get pods
        // -A -o json` across a cluster) can exceed it and throw. Allow override.
        maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
      });
    } catch (e) {
      lastError = e;
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

/**
 * Like execCommand, but feeds `input` to the child's stdin.
 *
 * Used where a script must reach a shell without going through the command line —
 * avoids both shell-quoting gymnastics and the `echo <base64> | base64 -d | sh`
 * pattern, which is indistinguishable from malware to anyone watching the process
 * table or an EDR agent.
 */
export async function execCommandWithInput(
  command: string,
  input: string,
  options: { timeout?: number; maxBuffer?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const timeout = options.timeout ?? 30000;
  const maxBuffer = options.maxBuffer ?? 16 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: getShell() });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (err: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve({ stdout, stderr });
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`Command timed out after ${timeout}ms`));
    }, timeout);

    child.stdout?.on("data", (d) => {
      if (stdout.length < maxBuffer) stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      if (stderr.length < maxBuffer) stderr += d.toString();
    });
    child.on("error", (e) => finish(e));
    child.on("close", (code) =>
      finish(code === 0 ? null : new Error(`exited with code ${code}: ${stderr.trim()}`)),
    );

    // The child may exit before draining stdin (e.g. bad image) — swallow EPIPE.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input);
  });
}

export function clearBinaryCache(): void {
  binaryCache.clear();
}
