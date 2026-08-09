import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ActionRequestSchema, PaymentParamsSchema } from "@adeia/shared";
import { z } from "zod";
import { DEMO_POLICY } from "./seed.ts";

/**
 * Generates everything under docs/json/ that has a source of truth in code.
 *
 * The point is that these files cannot drift: the JSON Schemas come from the
 * same zod objects the API validates with, and the seed policy comes from the
 * same constant `npm run seed` writes to the database.
 *
 *   npm run docs:json
 *
 * A test asserts the checked-in files match a fresh run, so drift fails CI
 * rather than quietly shipping a lying document.
 */

const OUT_DIR = fileURLToPath(new URL("../docs/json", import.meta.url));

export interface GeneratedFile {
  name: string;
  content: string;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export function generate(): GeneratedFile[] {
  return [
    {
      name: "action-request.schema.json",
      content: json({
        $id: "https://adeia.dev/schemas/action-request.json",
        title: "ActionRequest",
        description: "Body of POST /v1/actions. Generated from ActionRequestSchema.",
        ...z.toJSONSchema(ActionRequestSchema, { target: "draft-7" }),
      }),
    },
    {
      name: "payment-params.schema.json",
      content: json({
        $id: "https://adeia.dev/schemas/payment-params.json",
        title: "PaymentParams",
        description:
          "Params for a payment action. Amounts are integer cents; currency is a " +
          "lowercase ISO-4217 code. Generated from PaymentParamsSchema.",
        ...z.toJSONSchema(PaymentParamsSchema, { target: "draft-7" }),
      }),
    },
    {
      name: "seed-policy.json",
      content: json({
        _comment:
          "The policy `npm run seed` installs. Generated from DEMO_POLICY in " +
          "scripts/seed.ts — edit that constant, not this file.",
        ...DEMO_POLICY,
      }),
    },
  ];
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const file of generate()) {
    writeFileSync(new URL(`../docs/json/${file.name}`, import.meta.url), file.content);
    console.log(`  wrote docs/json/${file.name}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
