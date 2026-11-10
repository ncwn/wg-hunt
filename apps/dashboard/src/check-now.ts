import { useState } from "react";
import type { Result } from "./api/result.js";
import { type Mutation, useMutation } from "./mutation.js";
import type { CrawlNowAnswer, Search } from "./searches.js";

/**
 * Its answer is about the next check it was given for, so it goes once the Search's next check
 * moves on: the poll ran.
 *
 * `context` must not hold `poll.nextAt`: the click itself moves it, and the answer would be dropped.
 */
export function useCheckNow(
  search: Search,
  context: unknown,
  onCrawlNow: (id: number) => Promise<Result<CrawlNowAnswer>>,
) {
  const mutation = useMutation(context);
  const [givenFor, setGivenFor] = useState<Search["poll"]["nextAt"]>(null);
  const state: Mutation =
    mutation.state.status === "done" && givenFor !== search.poll.nextAt
      ? { status: "idle" }
      : mutation.state;

  function run() {
    const atClick = search.poll.nextAt;
    return mutation.run(
      async () => {
        const outcome = await onCrawlNow(search.id);
        // Without a re-read, the next read of the Search ends the answer, early rather than never.
        if (outcome.ok)
          setGivenFor(outcome.data.nextAt === undefined ? atClick : outcome.data.nextAt);
        return outcome;
      },
      (answer) => answer.message,
    );
  }

  return { state, busy: mutation.busy, run, reset: mutation.reset };
}
