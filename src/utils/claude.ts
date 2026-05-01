import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import { log } from "./logger";

dotenv.config();

if (!process.env.ANTHROPIC_API_KEY) {
  log.error(
    "ANTHROPIC_API_KEY is not set. Add it to .env once you have Anthropic credits."
  );
  throw new Error("ANTHROPIC_API_KEY is not set.");
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = "claude-opus-4-20250514";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function askClaude(
  prompt: string,
  systemPrompt?: string
): Promise<string> {
  const systemBlocks: Anthropic.TextBlockParam[] = systemPrompt
    ? [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ]
    : [];

  const maxRetries = 3;
  const backoffMs = [1000, 2000, 4000];

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 16000,
        ...(systemBlocks.length > 0 && { system: systemBlocks }),
        messages: [{ role: "user", content: prompt }],
      });

      if (!response.content.length) {
        throw new Error("Claude returned an empty content array.");
      }
      const firstBlock = response.content[0];
      if (firstBlock.type !== "text") {
        throw new Error(`Unexpected response block type: ${firstBlock.type}`);
      }
      return firstBlock.text;
    } catch (err) {
      const isOverload =
        err instanceof Anthropic.APIError && err.status === 529;
      if (isOverload && attempt < maxRetries - 1) {
        log.info(
          `Claude API overloaded (529). Retrying in ${backoffMs[attempt]}ms (attempt ${attempt + 1}/${maxRetries}).`
        );
        await sleep(backoffMs[attempt]);
        continue;
      }
      throw err;
    }
  }

  throw new Error("Claude API failed after maximum retries.");
}
