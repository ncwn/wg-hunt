import { cliProblem } from "./problem.js";

/** The prompt goes to stderr so stdout stays the command's result. */
export function promptHidden(label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { stdin, stderr } = process;
    let value = "";

    const finish = (outcome: () => void) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write("\n");
      outcome();
    };

    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n" || char === "\u0004") {
          return finish(() => resolve(value));
        }
        if (char === "\u0003") {
          return finish(() => reject(cliProblem("cancelled", "Cancelled")));
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };

    stderr.write(label);
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}
