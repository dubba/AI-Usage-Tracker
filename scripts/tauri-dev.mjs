import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEV_PORT = 1420;
const SHARE_CONFIG = '{"build":{"beforeDevCommand":""}}';
// Gives the desktop dev app its own identifier, so its data folder
// (~/Library/Application Support/com.dubba.ai.usage.tracker.dev on macOS) is
// separate from the installed app's. Dev builds keep logins as plain files,
// and removing an account in dev must never touch the real account list. It
// also gets its own name ("AI Usage Tracker Dev"), which launch at startup is
// registered under, so "Delete local app data" in dev cannot turn off the
// installed app's launch at startup.
export const DEV_IDENTITY_CONFIG = "src-tauri/tauri.dev.conf.json";

export function hasConfigFlag(args) {
  return args.some(
    (arg) =>
      arg === "--config" ||
      arg.startsWith("--config=") ||
      arg === "-c" ||
      arg.startsWith("-c="),
  );
}

export function buildTauriDevArgs(args, portInUse) {
  // Later --config values win, so a caller's own --config can still override.
  const result = ["dev", "--config", DEV_IDENTITY_CONFIG, ...args];
  if (portInUse && !hasConfigFlag(args)) {
    result.push("--config", SHARE_CONFIG);
  }
  return result;
}

function canConnect(host, port, timeoutMs = 250) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export async function isDevServerRunning(port = DEV_PORT) {
  return (await canConnect("127.0.0.1", port)) || (await canConnect("::1", port));
}

async function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const tauriCli = join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
  const extraArgs = process.argv.slice(2);
  const portInUse = await isDevServerRunning(DEV_PORT);

  if (portInUse && !hasConfigFlag(extraArgs)) {
    console.log(`Using the dev server already running on port ${DEV_PORT}.`);
  }

  const child = spawn(process.execPath, [tauriCli, ...buildTauriDevArgs(extraArgs, portInUse)], {
    cwd: root,
    stdio: "inherit",
  });

  const forwardSignal = (signal) => {
    if (!child.killed) {
      child.kill(signal);
    }
  };
  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

function isEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main();
}
