import { execFileSync } from "node:child_process";
import type { Plugin, ResolvedConfig } from "vite";

export interface BuildVersion {
  sha: string;
  shortSha: string;
  branch: string;
  builtAt: string;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

export function readBuildVersion(root: string, now = new Date()): BuildVersion {
  let sha = "unknown";
  let branch = "unknown";

  try {
    sha = git(root, ["rev-parse", "HEAD"]) || "unknown";
  } catch {
    sha = "unknown";
  }

  try {
    branch = git(root, ["branch", "--show-current"]) || "unknown";
  } catch {
    branch = "unknown";
  }

  if (sha !== "unknown" && branch === "unknown") {
    branch = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || "unknown";
  }

  return {
    sha,
    shortSha: sha === "unknown" ? "unknown" : sha.slice(0, 7),
    branch,
    builtAt: now.toISOString(),
  };
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function stampHtml(version: BuildVersion): string {
  const state = version.sha === "unknown" ? "unknown" : "unchecked";
  const warning = version.sha === "unknown" ? '<strong data-build-status>UNKNOWN</strong>' : '<strong data-build-status hidden></strong>';

  return `<aside id="odos-build-stamp" class="odos-build-stamp is-${state}" data-build-sha="${escapeHtml(version.sha)}" data-built-at="${escapeHtml(version.builtAt)}" aria-live="polite">
      <span>Build <code>${escapeHtml(version.shortSha)}</code> · ${escapeHtml(version.branch)}</span>
      <span>Built <time datetime="${escapeHtml(version.builtAt)}">${escapeHtml(version.builtAt)}</time></span>
      ${warning}
    </aside>`;
}

export function buildProvenancePlugin(): Plugin {
  let version: BuildVersion | undefined;

  return {
    name: "odos-build-provenance",
    apply: "build",
    configResolved(config: ResolvedConfig) {
      version = readBuildVersion(config.root);
    },
    buildStart() {
      if (!version) throw new Error("Build provenance was not initialized");
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: `${JSON.stringify(version, null, 2)}\n`,
      });
    },
    transformIndexHtml(html) {
      if (!version) throw new Error("Build provenance was not initialized");
      return html.replace("</body>", `  ${stampHtml(version)}\n  </body>`);
    },
  };
}
