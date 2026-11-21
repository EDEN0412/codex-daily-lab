import assert from "node:assert/strict";
import { test } from "node:test";
import { autoMerge } from "../.github/scripts/codex-auto-merge.mjs";

function fixture() {
  const repository = { id: 1, owner: { id: 2 } };
  const mainSha = "a".repeat(40);
  const headSha = "b".repeat(40);
  const head = { repo: { id: 1 }, ref: "codex/auto/example", sha: headSha };
  const base = { repo: { id: 1 }, ref: "main", sha: mainSha };
  const run = {
    id: 10,
    run_attempt: 1,
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    path: ".github/workflows/ci.yml",
    repository: { id: 1 },
    head_repository: { id: 1 },
    head_branch: head.ref,
    head_sha: headSha,
    pull_requests: [{ number: 3, head, base }],
  };
  const pr = {
    number: 3,
    state: "open",
    draft: false,
    user: { id: 2 },
    head: { ...head },
    base: { ...base },
    body: `Daily update\r\nCodex-Auto-Merge: ${headSha}\r\n`,
    mergeable: true,
    mergeable_state: "clean",
    changed_files: 1,
  };
  const verification = {
    name: "verify",
    head_sha: headSha,
    conclusion: "success",
    steps: ["Run npm ci", "Run npm run lint", "Run npm test"].map((name) => ({
      name,
      conclusion: "success",
    })),
  };
  const mergedSha = "c".repeat(40);
  const responses = {
    "pulls/3": pr,
    "pulls/3/files?per_page=100&page=1": [{ filename: "src/api.ts" }],
    "actions/runs/10/attempts/1/jobs": { jobs: [verification] },
    "actions/runs/10": { run_attempt: 1, conclusion: "success" },
    "branches/main": { commit: { sha: mainSha } },
    "pulls/3/merge": { merged: true, sha: mergedSha },
  };
  const writes = [];
  async function request(path, options) {
    assert.ok(Object.hasOwn(responses, path), `Unexpected API request: ${path}`);
    if (options?.method === "PUT") {
      writes.push({ path, ...options });
    }
    const response = responses[path];
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }
  return { run, pr, verification, responses, writes, mergedSha, execute: () =>
    autoMerge({ run, repository, mainSha, request }) };
}

for (const suffix of ["", "@main", "@refs/heads/codex/auto/example"]) {
  const path = `.github/workflows/ci.yml${suffix}`;
  test(`squash merges only the exact head that passed CI at ${path}`, async () => {
    const f = fixture();
    f.run.path = path;
    assert.deepEqual(await f.execute(), { outcome: "Merged", number: 3, sha: f.mergedSha });
    assert.deepEqual(f.writes, [
      { path: "pulls/3/merge", method: "PUT", body: { sha: f.run.head_sha, merge_method: "squash" } },
    ]);
  });
}

const excluded = {
  "failed CI": (f) => { f.run.conclusion = "failure"; },
  "push-only CI": (f) => { f.run.event = "push"; },
  "different workflow": (f) => { f.run.path = ".github/workflows/other.yml"; },
  "different workflow with a ref": (f) => { f.run.path = ".github/workflows/other.yml@main"; },
  "workflow with a similar filename": (f) => { f.run.path = ".github/workflows/ci.yml.bak@main"; },
  "manual branch": (f) => { f.run.head_branch = "codex/setup-auto-merge"; },
  "fork branch": (f) => { f.run.head_repository.id = 9; },
  "unassociated CI": (f) => { f.run.pull_requests = []; },
  "other PR author": (f) => { f.pr.user.id = 9; },
  "draft PR": (f) => { f.pr.draft = true; },
  "missing opt-in": (f) => { f.pr.body = ""; },
  "stale opt-in": (f) => { f.pr.body = `Codex-Auto-Merge: ${"e".repeat(40)}`; },
  "moved PR head": (f) => { f.pr.head.sha = "e".repeat(40); },
  "merge conflict": (f) => { f.pr.mergeable = false; },
  "branch protection block": (f) => { f.pr.mergeable_state = "blocked"; },
  "renamed workflow file": (f) => {
    f.responses["pulls/3/files?per_page=100&page=1"][0].previous_filename = ".github/workflows/ci.yml";
  },
  "incomplete changed-file list": (f) => { f.pr.changed_files = 2; },
  "skipped required CI step": (f) => { f.verification.steps[2].conclusion = "skipped"; },
  "superseded CI attempt": (f) => { f.responses["actions/runs/10"].run_attempt = 2; },
  "changed base branch SHA": (f) => { f.responses["branches/main"].commit.sha = "e".repeat(40); },
};

for (const [name, configure] of Object.entries(excluded)) {
  test(`does not attempt to merge: ${name}`, async () => {
    const f = fixture();
    configure(f);
    assert.equal((await f.execute()).outcome, "Skipped");
    assert.deepEqual(f.writes, []);
  });
}

for (const status of [403, 405, 409]) {
  test(`fails without retrying when GitHub refuses the merge (HTTP ${status})`, async () => {
    const f = fixture();
    f.responses["pulls/3/merge"] = new Error(`HTTP ${status}`);
    await assert.rejects(f.execute(), new RegExp(`HTTP ${status}`));
    assert.equal(f.writes.length, 1);
  });
}
