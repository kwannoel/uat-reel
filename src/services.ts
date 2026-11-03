import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Service } from "./schema.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STOP_GRACE_MS = 5000;

/** Runs commands in order, each an executable and its arguments with no shell. Async, so an app served from this same process keeps answering. */
export async function runCommands(commands: string[][], cwd: string, log: (line: string) => void, label = "setup"): Promise<void> {
  for (const [command, ...args] of commands) {
    const line = [command, ...args].join(" ");
    log(`${label}: ${line}`);
    await new Promise<void>((done, fail) => {
      const child = spawn(command!, args, { cwd, stdio: ["ignore", 2, 2] });
      child.on("error", (err) => fail(new Error(`${label} command failed (${err.message}): ${line}`)));
      child.on("close", (code) => (code === 0 ? done() : fail(new Error(`${label} command failed (exit ${code}): ${line}`))));
    });
  }
}

/** Any HTTP response means something is serving; a refused or reset connection does not. */
export async function answers(url: string, timeoutMs = 1000): Promise<boolean> {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

interface Started {
  name: string;
  child: ChildProcess;
  exited: Promise<void>;
}

const running = (s: Started) => s.child.exitCode === null && s.child.signalCode === null;

function signalGroup(s: Started, signal: NodeJS.Signals): void {
  try {
    process.kill(-s.child.pid!, signal);
  } catch {
    // The group is already gone.
  }
}

async function stopOne(s: Started): Promise<void> {
  if (!running(s)) return;
  signalGroup(s, "SIGTERM");
  await Promise.race([s.exited, sleep(STOP_GRACE_MS)]);
  if (running(s)) {
    signalGroup(s, "SIGKILL");
    await Promise.race([s.exited, sleep(1000)]);
  }
}

async function logTail(path: string, lines = 20): Promise<string> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}

export interface RunningServices {
  stop(): Promise<void>;
}

/**
 * Starts each service in order: its `before` commands, then the service in its own process group, then a wait until `ready` answers.
 * Refuses a service whose `ready` URL already answers, so a run never films an app it did not start.
 */
export async function startServices(
  services: Service[],
  opts: { root: string; out: string; log: (line: string) => void },
): Promise<RunningServices> {
  const started: Started[] = [];
  const stopAll = async () => {
    for (const s of [...started].reverse()) await stopOne(s);
  };
  // Last resort when the process exits without stopping them (an uncaught error): detached groups would outlive it.
  const onExit = () => started.filter(running).forEach((s) => signalGroup(s, "SIGKILL"));
  const onSignal = () => void stopAll().finally(() => process.exit(130));
  const detach = () => {
    process.off("exit", onExit);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
  process.on("exit", onExit);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    if (services.length) await mkdir(join(opts.out, "services"), { recursive: true });
    for (const service of services) {
      if (await answers(service.ready)) {
        throw new Error(
          `service ${service.name}: ${service.ready} already answers before it started; stop what is running there, or pass --no-services to film against it`,
        );
      }
      const cwd = resolve(opts.root, service.cwd ?? ".");
      await runCommands(service.before, cwd, opts.log, `${service.name} before`);

      const logPath = join(opts.out, "services", `${service.name}.log`);
      const output = createWriteStream(logPath);
      const [command, ...args] = service.run;
      opts.log(`service ${service.name}: ${service.run.join(" ")}`);
      const child = spawn(command!, args, {
        cwd,
        env: { ...process.env, ...service.env },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout!.pipe(output);
      child.stderr!.pipe(output);
      let failure: string | undefined;
      const exited = new Promise<void>((done) => {
        child.on("error", (err) => {
          failure = err.message;
          done();
        });
        child.on("exit", (code, signal) => {
          failure ??= `exit ${code ?? signal}`;
          done();
        });
      });
      started.push({ name: service.name, child, exited });

      const deadline = Date.now() + service.timeout;
      while (!(await answers(service.ready))) {
        if (failure) throw new Error(`service ${service.name} stopped (${failure}) before ${service.ready} answered:\n${await logTail(logPath)}`);
        if (Date.now() > deadline) throw new Error(`service ${service.name}: ${service.ready} did not answer within ${service.timeout} ms; log: ${logPath}`);
        await sleep(250);
      }
      opts.log(`service ${service.name}: ready at ${service.ready}`);
    }
  } catch (err) {
    await stopAll();
    detach();
    throw err;
  }

  return {
    async stop() {
      await stopAll();
      detach();
    },
  };
}
