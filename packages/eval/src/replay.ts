import type { AnalysisProvider, ModelFactsOutput } from "@wg-hunt/core";

/** Roughly four characters to a token; good enough to size a scripted call. */
const CHARS_PER_TOKEN = 4;

export function replayProvider(answers: readonly ModelFactsOutput[]): AnalysisProvider {
  let call = 0;
  return {
    async analyse(request) {
      const output = answers[Math.min(call, answers.length - 1)];
      call++;
      if (output === undefined) throw new Error("no scripted answer for this case");
      const tokens = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);
      return {
        output,
        usage: {
          inputTokens: tokens(request.prefix) + tokens(request.userTurn),
          outputTokens: tokens(JSON.stringify(output)),
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      };
    },
  };
}
