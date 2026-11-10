import { useState } from "react";
import type { ApiClient } from "../api/client.js";
import { ask } from "../api/result.js";
import { Button } from "../ui/Button.js";
import { Confirm } from "../ui/Confirm.js";
import { SettingRow, TextField } from "../ui/controls.js";
import { Notice } from "../ui/status.js";
import { Actions, Note, Section } from "./Section.js";

type Step =
  | { step: "idle" }
  | { step: "confirming" }
  | { step: "rotating" }
  // The token lives in this component's state only, so leaving the page forgets it.
  | { step: "shown"; token: string };

export function TokenSection({ api }: { api: ApiClient }) {
  const [state, setState] = useState<Step>({ step: "idle" });
  const [problem, setProblem] = useState<string>();
  const [copied, setCopied] = useState(false);

  async function rotate() {
    setState({ step: "rotating" });
    setProblem(undefined);
    const rotated = await ask(() => api.POST("/auth/token/rotate"));
    if (rotated.ok) return setState({ step: "shown", token: rotated.data.token });
    setProblem(rotated.message);
    setState({ step: "idle" });
  }

  async function copy(token: string) {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      setProblem("Couldn't copy it. Select the token and copy it by hand.");
    }
  }

  return (
    <Section title="Access token">
      {state.step === "shown" ? (
        <div className="adv-form">
          <TextField
            label="New access token"
            className="adv-token"
            readOnly
            value={state.token}
            onFocus={(event) => event.target.select()}
            spellCheck={false}
          />
          <Notice tone="warn">
            It's shown only once. Save it now: the CLI and agents need it, and the old token no
            longer works.
          </Notice>
          <Actions>
            <Button size="sm" variant="secondary" onClick={() => void copy(state.token)}>
              Copy token
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                setState({ step: "idle" });
                setCopied(false);
                setProblem(undefined);
              }}
            >
              Done
            </Button>
            {copied && <Note role="status">Copied.</Note>}
          </Actions>
        </div>
      ) : (
        <SettingRow
          title="Rotate the access token"
          description="Used by the CLI and agents"
          control={
            <Button size="sm" variant="secondary" onClick={() => setState({ step: "confirming" })}>
              Rotate access token
            </Button>
          }
        />
      )}
      {(state.step === "confirming" || state.step === "rotating") && (
        <Confirm
          question="Rotate the access token?"
          confirmLabel="Rotate token"
          danger
          busy={state.step === "rotating"}
          onConfirm={() => void rotate()}
          onCancel={() => setState({ step: "idle" })}
        >
          Every other browser is signed out, and the CLI and agents that use the current token stop
          working until they get the new one. This browser stays signed in.
        </Confirm>
      )}

      {problem && <Notice tone="alarm">{problem}</Notice>}
    </Section>
  );
}
