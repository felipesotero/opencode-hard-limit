import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Create a fake Claude CLI executable for isolated, cost-free tests. */
export function makeFakeClaude(binDir, { logFile, mode = "refresh" } = {}) {
  mkdirSync(binDir, { recursive: true });
  const binaryPath = join(binDir, "claude");
  const script = `#!${process.execPath}
(async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const mode = ${JSON.stringify(mode)};
  const logFile = ${JSON.stringify(logFile || "")};
  const args = process.argv.slice(2);

  if (args[0] === "--version") {
    process.stdout.write("2.1.302 (Claude Code)\\n");
    return;
  }

  if (args[0] === "--help") {
    const flags = [
      "--print",
      "--model <model>",
      "--output-format <format>",
      "--tools <tools>",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--safe-mode",
      "--max-budget-usd <amount>",
      "--bare",
    ];
    if (mode === "old") flags.splice(flags.indexOf("--strict-mcp-config"), 1);
    process.stdout.write(flags.join("\\n") + "\\n");
    return;
  }

  if (args.includes("-p")) {
    const relevantEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      key === "CLAUDE_CONFIG_DIR" || /^(ANTHROPIC_|CLAUDE_CODE_)/.test(key)));
    const log = {
      argv: args,
      cwd: process.cwd(),
      cwdMode: fs.statSync(process.cwd()).mode & 0o777,
      env: relevantEnv,
      pid: process.pid,
    };
    if (logFile) fs.appendFileSync(logFile, JSON.stringify(log) + "\\n");

    if (mode === "hang") {
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
      return;
    }
    if (mode === "fail") {
      process.stderr.write("fake Claude failure\\n");
      process.exitCode = 1;
      return;
    }

    if (mode === "refresh" || mode === "refresh-fail") {
      const credentialsPath = path.join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json");
      const credentials = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
      credentials.claudeAiOauth = credentials.claudeAiOauth || {};
      credentials.claudeAiOauth.accessToken = "fake-refreshed-" + process.pid;
      credentials.claudeAiOauth.expiresAt = Date.now() + 8 * 60 * 60 * 1000;
      fs.writeFileSync(credentialsPath, JSON.stringify(credentials));
    }
    process.stdout.write(JSON.stringify({ total_cost_usd: 0.015, is_error: false }) + "\\n");
    if (mode === "refresh-fail") process.exitCode = 1;
  }
})();
`;
  writeFileSync(binaryPath, script, "utf8");
  chmodSync(binaryPath, 0o755);
  return binaryPath;
}
