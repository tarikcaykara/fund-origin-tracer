// Runs the API (port 3000, watch mode) and the Vite dev server (port 5173) together.
const children = [
  Bun.spawn(["bun", "--watch", "apps/cli/src/main.ts", "serve"], {
    stdio: ["inherit", "inherit", "inherit"],
  }),
  Bun.spawn(["bun", "run", "--cwd", "apps/web", "dev"], {
    stdio: ["inherit", "inherit", "inherit"],
  }),
];

let stopping = false;
function stopAll(signal: "SIGINT" | "SIGTERM"): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill(signal);
  }
}

process.on("SIGINT", () => stopAll("SIGINT"));
process.on("SIGTERM", () => stopAll("SIGTERM"));

const firstExit = await Promise.race(children.map((child) => child.exited));
stopAll("SIGTERM");
await Promise.all(children.map((child) => child.exited));
process.exit(firstExit);
