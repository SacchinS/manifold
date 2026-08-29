import "dotenv/config";
import { query } from "@anthropic-ai/claude-agent-sdk";

// Throwaway spike: confirm the experimental usage/rate-limit control method
// actually returns real data for a subscription-authenticated session,
// before building the circuit breaker's logic around its shape.
async function main() {
  const q = query({ prompt: "Reply with just the word OK.", options: {} });

  // Fire the usage check concurrently with draining the message stream —
  // the control method lives on the same live Query handle.
  const usagePromise = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();

  for await (const message of q) {
    if (message.type === "result") {
      console.log("[spike] turn finished, subtype:", message.subtype);
    }
  }

  const usage = await usagePromise;
  console.log("\n[spike] rate_limits_available:", usage.rate_limits_available);
  console.log("[spike] subscription_type:", usage.subscription_type);
  console.log("[spike] five_hour:", JSON.stringify(usage.rate_limits?.five_hour));
  console.log("[spike] seven_day:", JSON.stringify(usage.rate_limits?.seven_day));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
