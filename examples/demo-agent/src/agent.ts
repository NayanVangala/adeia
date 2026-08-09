import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { AdeiaClient, AdeiaError, AdeiaTimeoutError } from "@adeia/sdk";
import { z } from "zod";

/**
 * The demo agent.
 *
 * An LLM is handed two invoices and one tool. It holds no payment credentials,
 * has no idea what executes on the other side, and has no way to raise its own
 * spending limit — the only thing it can do is ask Adeia, and Adeia decides.
 * That separation is the entire pitch, so it is never shortcut for the demo.
 */

/**
 * Builds the one tool the agent gets. Takes the client as an argument so the
 * tool's behaviour can be tested against an in-memory Adeia without a model,
 * an API key, or a running server.
 */
export function createPayVendorTool(adeia: AdeiaClient) {
  return betaZodTool({
    name: "pay_vendor",
    description:
      "Pay a vendor. Amount is in whole dollars. Returns the outcome, which may be that a human " +
      "must approve the payment first — in that case this tool waits for their decision.",
    inputSchema: z.object({
      vendor: z.string().describe("Vendor account id, e.g. acct_cloudhost"),
      amountDollars: z.number().positive(),
      description: z.string(),
    }),
    run: async ({ vendor, amountDollars, description }) => {
      const amountCents = Math.round(amountDollars * 100);

      console.log(
        `\n→ requesting $${amountDollars.toFixed(2)} to ${vendor} — ${description}`,
      );

      try {
        const requested = await adeia.requestAction({
          type: "payment",
          idempotencyKey: randomUUID(),
          params: {
            // The one and only float→cents conversion in the whole system. The
            // model talks in dollars; everything past this line is integer cents.
            // Without the round, $0.29 * 100 === 28.999999999999996 and the
            // payment is a cent short on screen.
            amountCents,
            currency: "usd",
            recipient: vendor,
            description,
          },
        });

        if (requested.status !== "pending_approval") {
          console.log(
            `   ${requested.status}: ${requested.decisionReason ?? ""}`,
          );
          return `Action ${requested.id}: ${requested.status}. ${requested.decisionReason ?? ""}`;
        }

        console.log(
          `\n⏸  $${amountDollars.toFixed(2)} to ${vendor} needs human approval.\n` +
            `   ${requested.decisionReason}\n` +
            `   Approval email sent. Waiting…\n`,
        );

        const final = await adeia.waitForAction(requested.id, {
          timeoutMs: 300_000,
        });
        console.log(`   resumed: ${final.status}`);
        return `Action ${final.id}: ${final.status}. ${final.decisionReason ?? ""}`;
      } catch (err) {
        // Reported back to the model as a tool result rather than thrown: the
        // agent should be able to say "that one failed" and carry on to the next
        // invoice, exactly as a person would.
        if (err instanceof AdeiaTimeoutError) {
          console.log(`   timed out waiting for a human`);
          return `No decision was made in time. The payment is still waiting for approval (${err.actionId}).`;
        }
        if (err instanceof AdeiaError) {
          console.log(`   error ${err.status} ${err.code}`);
          return `The payment could not be requested: ${err.code} (HTTP ${err.status}).`;
        }
        throw err;
      }
    },
  });
}

export const SYSTEM =
  "You are an operations agent that settles vendor invoices. Pay each invoice you are given, " +
  "one tool call at a time. Report the outcome of each payment plainly, including any that " +
  "required human approval or were refused by policy.";

export const INVOICES =
  "Settle these invoices:\n" +
  "1. acct_cloudhost — $25.00 — monthly hosting\n" +
  "2. acct_contractor — $500.00 — Q3 design work";

async function main(): Promise<void> {
  const apiKey = process.env["ADEIA_API_KEY"];
  const baseUrl = process.env["ADEIA_URL"] ?? "http://localhost:3000";

  if (!apiKey) {
    console.error(
      "ADEIA_API_KEY is not set. Run `npm run seed` and export the key it prints.",
    );
    process.exit(1);
  }
  if (!process.env["ANTHROPIC_API_KEY"]) {
    console.error(
      "ANTHROPIC_API_KEY is not set. The demo agent needs one; the Adeia server never calls a model.",
    );
    process.exit(1);
  }

  const payVendor = createPayVendorTool(new AdeiaClient({ apiKey, baseUrl }));

  console.log("─".repeat(72));
  console.log(
    "Adeia demo — the agent has one tool and no payment credentials.",
  );
  console.log(`Adeia at ${baseUrl}`);
  console.log("─".repeat(72));
  console.log(`\n${INVOICES}\n`);

  const final = await new Anthropic().beta.messages.toolRunner({
    // Exactly this string, no date suffix. Haiku 4.5 also rejects
    // `output_config.effort`, so neither it nor `thinking` is sent.
    model: "claude-haiku-4-5",
    max_tokens: 4096,
    tools: [payVendor],
    system: SYSTEM,
    messages: [{ role: "user", content: INVOICES }],
  });

  console.log(`\n${"─".repeat(72)}`);
  for (const block of final.content) {
    if (block.type === "text") console.log(block.text);
  }
  console.log("─".repeat(72));
  console.log(
    "\nSee the full trail for either action with:  npm run audit -- <actionId>\n",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
