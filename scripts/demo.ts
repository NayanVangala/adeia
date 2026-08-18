/**
 * The sixty-second demo.
 *
 * Three acts, in the order that makes the argument:
 *
 *   1. A read runs. The fence is not a wall.
 *   2. A write is judged by a model and runs. The fence is not a nag.
 *   3. A delete stops dead and waits for a person. The fence is a fence.
 *
 * Every call is real. Nothing here is simulated, which is the point — the
 * pauses on screen are the system actually thinking, and the verdicts are
 * whatever the classifier really said.
 *
 *   ADEIA_API_KEY=adeia_sk_… npm run demo:video
 */

import { AdeiaClient, type ActionRecord } from "../src/sdk/src/index.ts";

const KEY = process.env["ADEIA_API_KEY"];
const URL_BASE = process.env["ADEIA_URL"] ?? "http://localhost:3000";

if (!KEY) {
  console.error("\n  Set ADEIA_API_KEY first. Get one from the dashboard.\n");
  process.exit(1);
}

const adeia = new AdeiaClient({ apiKey: KEY, baseUrl: URL_BASE });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Wide enough to read on a phone, narrow enough not to wrap on a 720p crop.
const RULE = "─".repeat(64);

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const amber = (s: string) => `\x1b[33m${s}\x1b[0m`;
const violet = (s: string) => `\x1b[35m${s}\x1b[0m`;

/** Typed out rather than printed, so the viewer's eye can follow. */
async function type(line: string, msPerChar = 12): Promise<void> {
  for (const ch of line) {
    process.stdout.write(ch);
    await sleep(msPerChar);
  }
  process.stdout.write("\n");
}

function verdictLine(action: ActionRecord): string | null {
  const reason = action.decisionReason ?? "";
  if (reason.startsWith("a risk classifier judged this low risk")) {
    return violet(`  ⚖  ${reason.replace("a risk classifier judged this low risk and let it run: ", "model: ")}`);
  }
  if (reason.startsWith("a risk classifier flagged this")) {
    return violet(`  ⚖  ${reason.replace("a risk classifier flagged this: ", "model: ")}`);
  }
  return null;
}

function outcome(action: ActionRecord): string {
  switch (action.status) {
    case "executed":
      return green("  ✓  executed");
    case "pending_approval":
      return amber("  ⏸  waiting on a human");
    case "denied":
      return `\x1b[31m  ✗  refused — ${action.decisionReason}\x1b[0m`;
    default:
      return dim(`  ·  ${action.status}`);
  }
}

async function act(
  narration: string,
  params: { method: string; url: string; body?: unknown; description?: string },
): Promise<ActionRecord> {
  console.log("");
  await type(dim(`  ${narration}`), 14);
  await type(`  ${bold(params.method)} ${params.url}`, 6);
  await sleep(250);

  const action = await adeia.requestAction({
    type: "http",
    params: params as never,
  });

  const verdict = verdictLine(action);
  if (verdict) {
    await sleep(300);
    console.log(verdict);
  }
  await sleep(200);
  console.log(outcome(action));
  return action;
}

async function main(): Promise<void> {
  console.clear();
  console.log("");
  console.log(`  ${bold("Adeia")} ${dim("— agents act inside a fence you set")}`);
  console.log(dim(`  ${RULE}`));
  await sleep(700);

  // --- Act 1: a read just runs ---------------------------------------------
  await act("the agent reads the repo", {
    method: "GET",
    url: "https://api.github.com/repos/NayanVangala/adeia",
  });
  await sleep(900);

  // --- Act 2: a write, judged by a model -----------------------------------
  await act("the agent files an issue", {
    method: "POST",
    url: "https://api.github.com/repos/NayanVangala/adeia/issues",
    body: { title: "Flaky test in the approvals suite", body: "Fails under load." },
  });
  await sleep(900);

  // --- Act 3: the one that stops -------------------------------------------
  const held = await act("the agent tries to delete a DNS record", {
    method: "DELETE",
    url: "https://api.cloudflare.com/client/v4/zones/abc123/dns_records/xyz789",
  });

  if (held.status !== "pending_approval") {
    console.log(dim("\n  (expected this to stop for a human — check approvalMethods)\n"));
    return;
  }

  console.log("");
  console.log(dim(`  ${RULE}`));
  await type(amber("  Nothing has been sent. Approve it in the dashboard."), 14);
  console.log(dim(`  ${URL_BASE}/dashboard`));
  console.log("");

  // Poll until the human decides. This is the shot: the terminal sitting
  // still while you click Approve on screen.
  const start = Date.now();
  let final = held;
  while (final.status === "pending_approval" && Date.now() - start < 300_000) {
    await sleep(1_000);
    final = await adeia.getAction(held.id);
  }

  console.log("");
  if (final.status === "executed") {
    await type(green(`  ✓  approved — the request went out`), 14);
  } else if (final.status === "denied") {
    await type(`\x1b[31m  ✗  denied — it was never sent\x1b[0m`, 14);
  } else {
    await type(dim(`  ·  ${final.status}`), 14);
  }

  console.log("");
  console.log(dim(`  ${RULE}`));
  console.log(dim("  Every decision above is in the audit trail, including which"));
  console.log(dim("  ones a model made and which ones you did."));
  console.log("");
}

await main();
