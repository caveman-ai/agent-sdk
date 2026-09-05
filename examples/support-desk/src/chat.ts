// Interactive, streaming, multi-turn. One Conversation carries history across
// turns; the memory engine carries customer facts across processes, with
// recall landing one turn after it starts so it never blocks the current one.
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { createConversation, stream } from "@caveman-ai/agent";
import { supportDesk } from "./agent.ts";
import { memoryEngine, runOptions, tok, usd } from "./options.ts";

const conversation = createConversation();
const rl = createInterface({ input, output });
const closed = new Promise<null>((resolve) => rl.once("close", () => resolve(null)));
let sessionUsd = 0;

console.log("Northbeam support desk · streaming · memory on · 'quit' or Ctrl+D to leave\n");
try {
  while (true) {
    const answer = await Promise.race([rl.question("you> "), closed]);
    if (answer === null || answer.trim() === "quit") break;
    if (answer.trim() === "") continue;
    output.write("desk> ");
    for await (const event of stream(supportDesk, answer, { ...runOptions(), conversation })) {
      if (event.type === "pi") {
        const pi = event.event;
        if (pi.type === "message_update" && pi.assistantMessageEvent.type === "text_delta") {
          output.write(pi.assistantMessageEvent.delta);
        } else if (pi.type === "tool_execution_start") {
          output.write(`\n  [${pi.toolName}] `);
        }
      } else if (event.type === "run_end") {
        const result = event.result;
        sessionUsd += result.receipt.totalEstimatedUsd;
        const stopped = result.stopReason === "complete" ? "" : ` · stopped: ${result.stopReason}`;
        console.log(`\n  · ${usd(result.receipt.totalEstimatedUsd)} this turn · ${usd(sessionUsd)} this session` +
          ` · ${tok(result.cacheReadTokens)} tok read warm · list price, not an invoice${stopped}\n`);
      } else if (event.type === "run_error") {
        console.error(`\n  ! ${event.code}: ${event.message}\n`);
      }
    }
  }
} finally {
  rl.close();
  await memoryEngine.endSession(conversation.sessionId);
}
