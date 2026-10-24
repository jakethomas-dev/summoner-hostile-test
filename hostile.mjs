import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";

// Safety: run only inside a Docker container.
if (!fs.existsSync("/.dockerenv")) {
  console.log("hostile.mjs: not in Docker, skipping.");
  process.exit(0);
}

const phase = process.argv[2]; // "install" or "run"
const APP = process.cwd();
const SAVE = `${APP}/.hostile-install.txt`;
const PROXY = "http://summoner-proxy:3128";
const CAP = 2 * 1024 * 1024 * 1024;
const out = [];

const say = (ok, text) => {
  const line = `[hostile:${phase}] ${ok ? "PASS" : "FAIL"} ${text}`;
  console.log(line);
  out.push(line);
};

// Install results are saved, then printed again in the run phase.
if (phase === "run" && fs.existsSync(SAVE))
  console.log(fs.readFileSync(SAVE, "utf8"));

// 1. Network
const net = (name, args, expect) => {
  const r = spawnSync("curl", ["-sS", "-m", "5", "-o", "/dev/null", ...args], {
    encoding: "utf8",
  });
  const reached = r.status === 0;
  say(
    reached === (expect === "reach"),
    `network ${name}: ${reached ? "reachable" : "blocked"}`,
  );
};
net(
  "npm registry via proxy",
  ["--proxy", PROXY, "https://registry.npmjs.org/"],
  phase === "install" ? "reach" : "block",
);
net(
  "example.com via proxy",
  ["--proxy", PROXY, "https://example.com/"],
  "block",
);
net("example.com direct", ["--noproxy", "*", "https://example.com/"], "block");
net("1.1.1.1 direct", ["--noproxy", "*", "http://1.1.1.1/"], "block");
net("metadata address", ["--noproxy", "*", "http://169.254.169.254/"], "block");

// 2. Disk
const fill = (path) => {
  const chunk = Buffer.alloc(1024 * 1024, 1);
  let written = 0,
    err = null,
    fd;
  try {
    fd = fs.openSync(path, "w");
    while (written < CAP) {
      fs.writeSync(fd, chunk);
      written += chunk.length;
    }
  } catch (e) {
    err = e.code;
  }
  try {
    fs.closeSync(fd);
  } catch {}
  try {
    fs.unlinkSync(path);
  } catch {}
  say(
    err !== null,
    `disk ${path}: wrote ${Math.round(written / 1048576)} MB, stopped by ${err ?? "nothing (NOT LIMITED)"}`,
  );
};
[
  `${APP}/.fill`,
  "/tmp/.fill",
  "/home/node/.fill",
  "/var/tmp/.fill",
  "/.fill",
].forEach(fill);

// 3. Privileges
const status = fs.readFileSync("/proc/self/status", "utf8");
const field = (k) =>
  status.match(new RegExp(`^${k}:\\s*(.+)$`, "m"))?.[1].trim() ?? "";
say(field("Uid").split(/\s+/)[0] === "1000", `user id: ${field("Uid")}`);
say(/^0+$/.test(field("CapEff")), `capabilities: ${field("CapEff")}`);
say(field("NoNewPrivs") === "1", `no-new-privs: ${field("NoNewPrivs")}`);
say(!fs.existsSync("/var/run/docker.sock"), "docker socket absent");

// 4. Environment
const keys = Object.keys(process.env);
const vite = keys.filter((k) => k.startsWith("VITE_"));
const proxyVars = keys.filter((k) => /proxy/i.test(k) && k !== 'npm_config_noproxy');
if (phase === "install") {
  say(vite.length === 0, `VITE_ variables in install phase: ${vite.length}`);
  fs.writeFileSync(SAVE, out.join("\n") + "\n");
} else {
  say(
    proxyVars.length === 0,
    `proxy variables in run phase: ${proxyVars.length} ${JSON.stringify(proxyVars)}`,
  );
  console.log(
    `[hostile:run] secret check, must show ***: ${process.env.VITE_SECRET_TEST ?? "(VITE_SECRET_TEST not set)"}`,
  );
}

// 5. Optional destructive modes (run phase). Set VITE_HOSTILE in the .env field.
const mode = process.env.VITE_HOSTILE;
if (phase === "run" && mode === "memory") {
  console.log("[hostile:run] memory bomb start");
  const keep = [];
  for (;;) keep.push(Buffer.alloc(50 * 1024 * 1024, 1));
}
if (phase === "run" && mode === "fork") {
  const kids = [];
  let refused = 0;
  for (let i = 0; i < 2000; i++) {
    const c = spawn("sleep", ["30"], { stdio: "ignore" });
    c.on("error", () => {});
    if (c.pid) kids.push(c);
    else refused++;
  }
  say(refused > 0, `fork test: started ${kids.length}, refused ${refused}`);
  kids.forEach((c) => c.kill());
}
if (phase === "run" && mode === "cpu") {
  console.log("[hostile:run] cpu spin for 20 s. On the host run: docker stats");
  for (let i = 0; i < 4; i++) new Worker("while (true) {}", { eval: true });
  setTimeout(() => process.exit(0), 20000);
}
