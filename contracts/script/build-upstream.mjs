/* global process */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const ARTIFACT_DIR = path.join(ROOT, "contracts/out-upstream");
const MANIFEST_PATH = path.join(ARTIFACT_DIR, "manifest.json");
const COMPILER_VERSION = "0.8.30";
const OPTIMIZER_RUNS = 700;

const PINNED_SOURCES = {
  wrapper: {
    repository: "AURKA",
    commit: null,
    path: "contracts/upstream/AurkaUpstreamAquaSwapVMRouter.sol",
  },
  aqua: {
    repository: "1inch/aqua",
    commit: "9c5c42e5840e8741fba3597c48456c9510212b66",
    root: "contracts/vendor/aqua/src",
  },
  swapVM: {
    repository: "1inch/swap-vm",
    commit: "afd99c408b4ed610027f4426c6f98650acac9f5f",
    root: "contracts/vendor/swap-vm/contracts",
  },
  solidityUtils: {
    repository: "1inch/solidity-utils",
    commit: "2d91bb67665467afc06907a69513b0fa66c46f0d",
    root: "contracts/vendor/solidity-utils/contracts",
  },
  openzeppelin: {
    repository: "OpenZeppelin/openzeppelin-contracts",
    commit: null,
    root: "contracts/vendor/openzeppelin-contracts/contracts",
  },
};

const ARTIFACTS = {
  aqua: "contracts/out-upstream/Aqua.sol/Aqua.json",
  swapVM:
    "contracts/out-upstream/AurkaUpstreamAquaSwapVMRouter.sol/AurkaUpstreamAquaSwapVMRouter.json",
};

function absolute(relativePath) {
  return path.join(ROOT, relativePath);
}

function relative(filePath) {
  return path.relative(ROOT, filePath).split(path.sep).join("/");
}

function sourceFiles(rootPath) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && entry.name.endsWith(".sol"))
        files.push(entryPath);
    }
  };
  visit(rootPath);
  return files;
}

function pinnedSourceFiles() {
  const files = [absolute(PINNED_SOURCES.wrapper.path)];
  for (const source of Object.values(PINNED_SOURCES)) {
    if (source.root) files.push(...sourceFiles(absolute(source.root)));
  }
  return [...new Set(files)].sort();
}

function sourceFingerprint() {
  const hash = createHash("sha256");
  for (const filePath of pinnedSourceFiles()) {
    hash.update(relative(filePath));
    hash.update("\0");
    hash.update(readFileSync(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function gitHead(root) {
  return execFileSync("git", ["-C", absolute(root), "rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
}

function sourcePins() {
  return Object.fromEntries(
    Object.entries(PINNED_SOURCES).map(([name, source]) => [
      name,
      {
        repository: source.repository,
        commit: source.commit ?? gitHead(source.root ?? "."),
      },
    ]),
  );
}

function artifactJson(relativePath) {
  const filePath = absolute(relativePath);
  if (!existsSync(filePath))
    throw new Error(
      `Missing pinned upstream artifact ${relativePath}; run pnpm contracts:build-upstream`,
    );
  const artifact = JSON.parse(readFileSync(filePath, "utf8"));
  if (!artifact.bytecode?.object || artifact.bytecode.object === "0x")
    throw new Error(
      `Pinned upstream artifact ${relativePath} has no creation bytecode`,
    );
  return artifact;
}

function artifactFingerprint(relativePath) {
  const artifact = artifactJson(relativePath);
  return {
    path: relativePath,
    creationBytecodeSha256: createHash("sha256")
      .update(artifact.bytecode.object)
      .digest("hex"),
    deployedBytecodeSha256: createHash("sha256")
      .update(artifact.deployedBytecode?.object ?? "0x")
      .digest("hex"),
    compiler: artifact.metadata?.compiler?.version,
  };
}

function expectedManifest() {
  return {
    schemaVersion: 1,
    generatedBy: "contracts/script/build-upstream.mjs",
    compiler: {
      version: COMPILER_VERSION,
      optimizerRuns: OPTIMIZER_RUNS,
      viaIR: true,
      bytecodeHash: "none",
      appendCBOR: false,
    },
    sourcePins: sourcePins(),
    sourceFingerprint: sourceFingerprint(),
    artifacts: Object.values(ARTIFACTS).map(artifactFingerprint),
  };
}

function assertManifest(manifest) {
  const expected = expectedManifest();
  if (manifest.schemaVersion !== expected.schemaVersion)
    throw new Error("Pinned upstream artifact manifest schema is unsupported");
  if (JSON.stringify(manifest.compiler) !== JSON.stringify(expected.compiler))
    throw new Error(
      "Pinned upstream artifacts use the wrong compiler/settings; run pnpm contracts:build-upstream",
    );
  if (
    JSON.stringify(manifest.sourcePins) !== JSON.stringify(expected.sourcePins)
  )
    throw new Error(
      "Pinned upstream sources changed; run pnpm contracts:build-upstream before testing",
    );
  if (manifest.sourceFingerprint !== expected.sourceFingerprint)
    throw new Error(
      "Pinned upstream sources are stale in the artifact directory; run pnpm contracts:build-upstream",
    );
  for (const expectedArtifact of expected.artifacts) {
    const actualArtifact = manifest.artifacts?.find(
      (artifact) => artifact.path === expectedArtifact.path,
    );
    if (
      !actualArtifact ||
      JSON.stringify(actualArtifact) !== JSON.stringify(expectedArtifact)
    )
      throw new Error(
        `Pinned upstream artifact ${expectedArtifact.path} is missing or stale; run pnpm contracts:build-upstream`,
      );
    const artifact = artifactJson(expectedArtifact.path);
    const metadata = artifact.metadata;
    if (
      metadata?.compiler?.version !== `${COMPILER_VERSION}+commit.73712a01` ||
      metadata.settings?.optimizer?.runs !== OPTIMIZER_RUNS ||
      metadata.settings?.viaIR !== true ||
      metadata.settings?.metadata?.bytecodeHash !== "none" ||
      metadata.settings?.metadata?.appendCBOR !== false
    )
      throw new Error(
        `Pinned upstream artifact ${expectedArtifact.path} was not compiled with the pinned settings; run pnpm contracts:build-upstream`,
      );
  }
}

function build() {
  mkdirSync(path.dirname(ARTIFACT_DIR), { recursive: true });
  rmSync(ARTIFACT_DIR, { recursive: true, force: true });
  const result = spawnSync(
    "forge",
    [
      "build",
      "contracts/vendor/aqua/src/Aqua.sol",
      "contracts/upstream/AurkaUpstreamAquaSwapVMRouter.sol",
      "--use",
      COMPILER_VERSION,
      "--optimizer-runs",
      String(OPTIMIZER_RUNS),
      "--out",
      "contracts/out-upstream",
      "--skip",
      "test",
      "--force",
    ],
    { cwd: ROOT, stdio: "inherit" },
  );
  if (result.status !== 0)
    throw new Error(
      `Pinned upstream artifact build failed with status ${result.status}`,
    );
  const manifest = expectedManifest();
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  assertManifest(manifest);
  globalThis.console.log(`Pinned upstream artifacts ready: ${ARTIFACT_DIR}`);
}

function check() {
  if (!existsSync(MANIFEST_PATH))
    throw new Error(
      "Pinned upstream artifact manifest is missing; run pnpm contracts:build-upstream",
    );
  assertManifest(JSON.parse(readFileSync(MANIFEST_PATH, "utf8")));
  globalThis.console.log("Pinned upstream artifact check passed");
}

try {
  if (process.argv.includes("--check")) check();
  else build();
} catch (error) {
  globalThis.console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
