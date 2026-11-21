import { readFile, appendFile } from "node:fs/promises";
import process from "node:process";

const branchPattern = /^codex\/auto\/[a-z0-9][a-z0-9/-]*$/;
const shaPattern = /^[a-f0-9]{40}$/;
const verificationSteps = ["Run npm ci", "Run npm run lint", "Run npm test"];

function skipped(reason) {
  return { outcome: "Skipped", reason };
}

function isEligiblePr(pr, run, repository, mainSha) {
  const optIn = `Codex-Auto-Merge: ${run.head_sha}`;
  return pr.state === "open" &&
    !pr.draft &&
    pr.user?.id === repository.owner.id &&
    pr.head.repo?.id === repository.id &&
    pr.head.ref === run.head_branch &&
    pr.head.sha === run.head_sha &&
    pr.base.repo.id === repository.id &&
    pr.base.ref === "main" &&
    pr.base.sha === mainSha &&
    pr.body?.split(/\r?\n/).some((line) => line === optIn);
}

function canMerge(pr) {
  return pr.mergeable === true && pr.mergeable_state === "clean";
}

export async function autoMerge({ run, repository, mainSha, request }) {
  const workflowPath = run.path?.split("@", 1)[0];
  if (
    run.event !== "pull_request" ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    workflowPath !== ".github/workflows/ci.yml" ||
    run.repository?.id !== repository.id ||
    run.head_repository?.id !== repository.id ||
    !branchPattern.test(run.head_branch) ||
    !shaPattern.test(run.head_sha)
  ) {
    return skipped("The event is not a successful CI run for a dedicated branch.");
  }

  const candidates = run.pull_requests.filter(({ head, base }) =>
    head.repo.id === repository.id &&
    head.ref === run.head_branch &&
    head.sha === run.head_sha &&
    base.repo.id === repository.id &&
    base.ref === "main" &&
    base.sha === mainSha,
  );
  if (candidates.length !== 1) {
    return skipped("CI is not associated with exactly one PR against this main revision.");
  }

  const prPath = `pulls/${candidates[0].number}`;
  const pr = await request(prPath);
  if (!isEligiblePr(pr, run, repository, mainSha)) {
    return skipped("The PR is stale, ineligible, or missing opt-in for this exact head SHA.");
  }

  if (!canMerge(pr)) {
    return skipped("GitHub does not report a clean, mergeable PR.");
  }

  let inspectedFiles = 0;
  while (inspectedFiles < pr.changed_files) {
    const page = Math.floor(inspectedFiles / 100) + 1;
    if (page > 30) {
      return skipped("GitHub cannot list every changed file for review.");
    }
    const files = await request(`${prPath}/files?per_page=100&page=${page}`);
    if (files.length === 0 || files.some(({ filename, previous_filename }) =>
      filename.startsWith(".github/") || previous_filename?.startsWith(".github/"),
    )) {
      return skipped("Changes under .github/ or an incomplete file list require manual review.");
    }
    inspectedFiles += files.length;
    if (files.length < 100) {
      break;
    }
  }
  if (inspectedFiles !== pr.changed_files) {
    return skipped("The changed file list does not match GitHub's PR metadata.");
  }

  const runPath = `actions/runs/${run.id}`;
  const { jobs } = await request(`${runPath}/attempts/${run.run_attempt}/jobs`);
  const verify = jobs.find((job) =>
    job.name === "verify" &&
    job.head_sha === run.head_sha &&
    job.conclusion === "success",
  );
  if (!verify || !verificationSteps.every((name) =>
    verify.steps.some((step) => step.name === name && step.conclusion === "success"),
  )) {
    return skipped("CI did not successfully run dependency installation, lint, and tests/type-check.");
  }

  const latestRun = await request(runPath);
  if (latestRun.run_attempt !== run.run_attempt || latestRun.conclusion !== "success") {
    return skipped("A newer CI attempt superseded the successful run.");
  }
  const base = await request("branches/main");
  if (base.commit.sha !== mainSha) {
    return skipped("main advanced after CI. Update the PR branch and run CI again.");
  }

  const latestPr = await request(prPath);
  if (!isEligiblePr(latestPr, run, repository, mainSha) || !canMerge(latestPr)) {
    return skipped("The PR is no longer eligible or mergeable.");
  }

  const result = await request(`${prPath}/merge`, {
    method: "PUT",
    body: { sha: run.head_sha, merge_method: "squash" },
  });
  if (result.merged !== true || !shaPattern.test(result.sha)) {
    throw new Error("GitHub did not confirm the squash merge.");
  }
  return { outcome: "Merged", number: pr.number, sha: result.sha };
}

async function main() {
  const {
    GITHUB_API_URL, GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GITHUB_SERVER_URL,
    GITHUB_SHA, GITHUB_STEP_SUMMARY, GITHUB_TOKEN,
  } = process.env;
  const request = async (path, { method = "GET", body } = {}) => {
    const response = await globalThis.fetch(`${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: globalThis.AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`GitHub API ${method} ${path} returned HTTP ${response.status}.`);
    }
    return response.json();
  };

  try {
    const { workflow_run: run, repository } = JSON.parse(await readFile(GITHUB_EVENT_PATH, "utf8"));
    const result = await autoMerge({ run, repository, mainSha: GITHUB_SHA, request });
    const repoUrl = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}`;
    const detail = result.reason ??
      `[PR #${result.number}](${repoUrl}/pull/${result.number}) → [\`${result.sha}\`](${repoUrl}/commit/${result.sha})`;
    await appendFile(GITHUB_STEP_SUMMARY, `## ${result.outcome}\n\n${detail}\n`);
  } catch (error) {
    await appendFile(GITHUB_STEP_SUMMARY, `## Auto-merge error\n\n${error.message}\n`);
    throw error;
  }
}

if (import.meta.main) {
  await main();
}
