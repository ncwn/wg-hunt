import { type FormEvent, useState } from "react";
import type { ApiClient } from "../api/client.js";
import { ask } from "../api/result.js";
import type { components } from "../api/schema.js";
import { useMutation } from "../mutation.js";
import { Button } from "../ui/Button.js";
import { Confirm } from "../ui/Confirm.js";
import { SettingRow, TextField } from "../ui/controls.js";
import { Notice } from "../ui/status.js";
import { useLoaded } from "./request.js";
import { Actions, Note, Problem, Section } from "./Section.js";

type Secret = components["schemas"]["Secret"];

const LABELS: Record<Secret["name"], { title: string; purpose: string; without: string }> = {
  anthropic: {
    title: "Anthropic API key",
    purpose: "Reads each ad with a model",
    without: "New offers wait unread until you set a key again.",
  },
};

function SecretRow({
  api,
  secret,
  onChange,
}: {
  api: ApiClient;
  secret: Secret;
  onChange: (secret: Secret) => void;
}) {
  const { title, purpose, without } = LABELS[secret.name];
  const [mode, setMode] = useState<"view" | "set" | "clear">("view");
  const [value, setValue] = useState("");
  const action = useMutation(mode);
  const path = { params: { path: { name: secret.name } } };

  function close() {
    // The typed value is dropped as soon as the field closes.
    setMode("view");
    setValue("");
  }

  function save(event: FormEvent) {
    event.preventDefault();
    void action.run(async () => {
      const saved = await ask(() => api.PUT("/secrets/{name}", { ...path, body: { value } }));
      if (!saved.ok) return saved;
      onChange(saved.data);
      close();
      return { ok: true, data: undefined };
    });
  }

  function clear() {
    void action.run(async () => {
      const cleared = await ask(() => api.DELETE("/secrets/{name}", path), { empty: true });
      if (!cleared.ok) return cleared;
      onChange({ ...secret, set: false, masked: null, updatedAt: null });
      setMode("view");
      return { ok: true, data: undefined };
    });
  }

  const problem = action.state.status === "failed" ? action.state.message : undefined;

  return (
    <li className="adv-secret">
      <SettingRow
        title={title}
        description={purpose}
        control={
          <>
            <span className={secret.set ? "adv-secret-hint" : "adv-cell-muted"}>
              {secret.set ? secret.masked : "Not set"}
            </span>
            {mode !== "set" && (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label={`Set ${title}`}
                  disabled={action.busy}
                  onClick={() => setMode("set")}
                >
                  Set
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label={`Clear ${title}`}
                  disabled={action.busy || !secret.set}
                  onClick={() => setMode("clear")}
                >
                  Clear
                </Button>
              </>
            )}
          </>
        }
      />
      {mode === "set" && (
        <form className="adv-form" onSubmit={save} noValidate>
          <TextField
            label={`${title} value`}
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            hint="It's kept in wg-hunt's data folder and never shown again."
          />
          <Actions>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={action.busy || value.trim() === ""}
            >
              Save key
            </Button>
            <Button variant="ghost" size="sm" onClick={close}>
              Cancel
            </Button>
          </Actions>
          {problem && <Notice tone="alarm">{problem}</Notice>}
        </form>
      )}
      {mode === "clear" && (
        <Confirm
          question={`Clear the ${title}?`}
          confirmLabel="Clear key"
          danger
          busy={action.busy}
          problem={problem}
          onConfirm={clear}
          onCancel={() => setMode("view")}
        >
          {without} The key is deleted from wg-hunt and can't be shown again.
        </Confirm>
      )}
    </li>
  );
}

export function SecretsSection({ api }: { api: ApiClient }) {
  const { state, retry } = useLoaded(() => ask(() => api.GET("/secrets")));
  const [changes, setChanges] = useState<Record<string, Secret>>({});

  return (
    <Section title="Keys">
      {state.status === "loading" && <Note role="status">Loading…</Note>}
      {state.status === "failed" && <Problem message={state.message} onRetry={retry} />}
      {state.status === "ready" && (
        <ul className="adv-secrets">
          {state.data.map((listed) => {
            const secret = changes[listed.name] ?? listed;
            return (
              <SecretRow
                key={secret.name}
                api={api}
                secret={secret}
                onChange={(next) => {
                  setChanges((all) => ({ ...all, [next.name]: next }));
                }}
              />
            );
          })}
        </ul>
      )}
    </Section>
  );
}
