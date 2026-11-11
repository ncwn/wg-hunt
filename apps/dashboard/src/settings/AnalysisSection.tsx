import { useEffect, useMemo, useState } from "react";
import type { ApiClient } from "../api/client.js";
import { useSettingsDraft } from "../draft.js";
import { useMutation } from "../mutation.js";
import { rebase } from "../rebase.js";
import {
  CHANGED_ELSEWHERE,
  changedElsewhereUnread,
  type Doc,
  ifMatch,
  readDoc,
} from "../revision.js";
import { Button } from "../ui/Button.js";
import { ChipGroup, SelectField, SettingRow, TextField, Toggle } from "../ui/controls.js";
import { Disclosure, Notice } from "../ui/status.js";
import {
  type AnalysisForm,
  type AnalysisSettings,
  EFFORTS,
  type Effort,
  effortFor,
  effortsOf,
  isAmount,
  isModelId,
  toForm,
  toSettings,
} from "./form.js";
import { ReanalysisPanel } from "./ReanalysisPanel.js";
import { Actions, Note, Section } from "./Section.js";

function EffortSelect({
  label,
  efforts,
  value,
  disabled,
  onChange,
}: {
  label: string;
  efforts: readonly Effort[];
  value: Effort | null;
  disabled?: boolean;
  onChange: (effort: Effort) => void;
}) {
  const unsupported = efforts.length === 0;
  return (
    <SelectField<string>
      hideLabel
      label={label}
      value={value ?? ""}
      disabled={disabled || unsupported}
      options={
        unsupported
          ? [{ value: "", label: "Not supported" }]
          : efforts.map((effort) => ({ value: effort, label: effort }))
      }
      onChange={(effort) => onChange(effort as Effort)}
    />
  );
}

function ModelSelect({
  label,
  models,
  value,
  disabled,
  onChange,
}: {
  label: string;
  models: string[];
  value: string;
  disabled?: boolean;
  onChange: (model: string) => void;
}) {
  return (
    <SelectField<string>
      hideLabel
      label={label}
      value={value}
      disabled={disabled}
      options={models.map((model) => ({ value: model, label: model }))}
      onChange={onChange}
    />
  );
}

function PriceTable({
  form,
  onChange,
}: {
  form: AnalysisForm;
  onChange: (form: AnalysisForm) => void;
}) {
  const [id, setId] = useState("");
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [efforts, setEfforts] = useState<Effort[]>([]);
  const [problem, setProblem] = useState<string>();

  const inUse = (model: string) =>
    model === form.model || (form.escalationOn && model === form.escalationModel);

  function setPrice(model: string, field: "input" | "output", value: string) {
    onChange({
      ...form,
      prices: form.prices.map((price) =>
        price.model === model ? { ...price, [field]: value } : price,
      ),
    });
  }

  function add() {
    const model = id.trim();
    if (!isModelId(model)) {
      return setProblem(
        "Enter a model id such as claude-haiku-5-5: lower case letters, digits and . _ : -",
      );
    }
    if (form.prices.some((price) => price.model === model)) {
      return setProblem(`${model} is already in the price table.`);
    }
    if (!isAmount(input) || !isAmount(output)) {
      return setProblem("Enter both prices in US dollars per million tokens, such as 0.10.");
    }
    onChange({
      ...form,
      prices: [
        ...form.prices,
        {
          model,
          input: input.trim(),
          output: output.trim(),
          efforts: EFFORTS.filter((effort) => efforts.includes(effort)),
        },
      ],
    });
    setId("");
    setInput("");
    setOutput("");
    setEfforts([]);
    setProblem(undefined);
  }

  return (
    <section className="adv-fold" aria-label="Price table">
      <Disclosure title="Prices" hint="$ per million tokens">
        <div className="adv-table-wrap">
          <table className="adv-table adv-prices">
            <caption className="wh-sr">Price table</caption>
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Input</th>
                <th scope="col">Output</th>
                <th scope="col">Efforts</th>
                <th scope="col">
                  <span className="wh-sr">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {form.prices.map((price) => (
                <tr key={price.model}>
                  <th scope="row">
                    <code className="adv-code">{price.model}</code>
                  </th>
                  <td>
                    <TextField
                      className="adv-price"
                      prefix="$"
                      inputMode="decimal"
                      aria-label={`${price.model} input price`}
                      value={price.input}
                      onChange={(event) => setPrice(price.model, "input", event.target.value)}
                    />
                  </td>
                  <td>
                    <TextField
                      className="adv-price"
                      prefix="$"
                      inputMode="decimal"
                      aria-label={`${price.model} output price`}
                      value={price.output}
                      onChange={(event) => setPrice(price.model, "output", event.target.value)}
                    />
                  </td>
                  <td className="adv-cell-muted">{price.efforts.join(", ") || "none"}</td>
                  <td className="adv-cell-end">
                    <Button
                      size="sm"
                      variant="secondary"
                      aria-label={`Remove ${price.model}`}
                      disabled={inUse(price.model)}
                      title={
                        inUse(price.model) ? "The model or the second read uses it" : undefined
                      }
                      onClick={() =>
                        onChange({
                          ...form,
                          prices: form.prices.filter((p) => p.model !== price.model),
                        })
                      }
                    >
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <fieldset className="adv-group adv-add">
          <legend className="adv-label">Add a model</legend>
          <div className="adv-fields">
            <TextField
              label="Model id"
              value={id}
              onChange={(event) => setId(event.target.value)}
              spellCheck={false}
            />
            <TextField
              label="Input price"
              prefix="$"
              inputMode="decimal"
              value={input}
              onChange={(event) => setInput(event.target.value)}
            />
            <TextField
              label="Output price"
              prefix="$"
              inputMode="decimal"
              value={output}
              onChange={(event) => setOutput(event.target.value)}
            />
          </div>
          <ChipGroup
            legend="Efforts it supports"
            options={EFFORTS.map((effort) => ({ value: effort, label: effort }))}
            chosen={efforts}
            onChange={setEfforts}
          />
          {problem && <Notice tone="alarm">{problem}</Notice>}
          <Actions>
            <Button size="sm" variant="secondary" onClick={add}>
              Add to price table
            </Button>
          </Actions>
        </fieldset>
      </Disclosure>
    </section>
  );
}

export type HeldAnalysis = {
  saved: AnalysisForm;
  form: AnalysisForm;
  revision: string | undefined;
};

function Form({
  api,
  stored,
  onSaved,
}: {
  api: ApiClient;
  stored: Doc<AnalysisSettings>;
  onSaved: (settings: Doc<AnalysisSettings>) => void;
}) {
  const fresh = useMemo(() => toForm(stored.data), [stored]);
  const kept = useSettingsDraft();
  const [held, setHeld] = useState<HeldAnalysis>(
    () => kept.analysis ?? { saved: fresh, form: fresh, revision: stored.revision },
  );
  useEffect(() => {
    setHeld((now) => ({
      saved: fresh,
      form: rebase(now.saved, now.form, fresh),
      revision: stored.revision,
    }));
  }, [fresh, stored.revision]);
  const { saved, form } = held;
  const setForm = (next: AnalysisForm) => setHeld((now) => ({ ...now, form: next }));
  const saving = useMutation();
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const { setAnalysis } = kept;
  useEffect(() => setAnalysis(dirty ? held : null), [held, dirty, setAnalysis]);
  const models = form.prices.map((price) => price.model);

  // A save on its way keeps its pending state, so it can't be sent twice.
  function settle() {
    if (!saving.busy) saving.reset();
  }

  function edit(next: AnalysisForm) {
    setForm(next);
    settle();
  }

  function changeModel(model: string) {
    edit({ ...form, model, effort: effortFor(effortsOf(form.prices, model), form.effort) });
  }

  function changeEscalationModel(escalationModel: string) {
    edit({
      ...form,
      escalationModel,
      escalationEffort: effortFor(
        effortsOf(form.prices, escalationModel),
        form.escalationEffort,
        "high",
      ),
    });
  }

  function save() {
    const sent = form;
    const revision = held.revision;
    void saving.run(
      async () => {
        const result = toSettings(sent);
        if ("problem" in result) return { ok: false, message: result.problem };
        const written = await readDoc(() =>
          api.PUT("/settings/analysis", { body: result.settings, params: ifMatch(revision) }),
        );
        if (!written.ok) {
          if (written.status !== 412) return written;
          const latest = await readDoc(() => api.GET("/settings/analysis"));
          if (!latest.ok) return { ok: false, message: changedElsewhereUnread(latest.message) };
          onSaved(latest.data);
          return { ok: false, message: CHANGED_ELSEWHERE };
        }
        const doc = written.data;
        const next = toForm(doc.data);
        // What was sent is saved; anything edited while it was on its way stays an edit.
        setHeld((now) => ({
          saved: next,
          form: rebase(sent, now.form, next),
          revision: doc.revision,
        }));
        // The seeker may have left Settings by now, so the kept copy learns of the save as well:
        // otherwise it would keep the dot, and bring the saved edit back over a later change.
        setAnalysis((kept) => {
          if (!kept) return null;
          const form = rebase(sent, kept.form, next);
          return JSON.stringify(form) === JSON.stringify(next)
            ? null
            : { saved: next, form, revision: doc.revision };
        });
        onSaved(doc);
        return { ok: true, data: undefined };
      },
      () => "Saved.",
    );
  }

  return (
    <form
      className="adv-form"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
      noValidate
    >
      <div className="adv-rows">
        <SettingRow
          layout="field"
          title="Model"
          control={
            <ModelSelect label="Model" models={models} value={form.model} onChange={changeModel} />
          }
        />
        <SettingRow
          layout="field"
          title="Effort"
          description="Higher costs more"
          control={
            <EffortSelect
              label="Effort"
              efforts={effortsOf(form.prices, form.model)}
              value={form.effort}
              onChange={(effort) => edit({ ...form, effort })}
            />
          }
        />
        <SettingRow
          title="Second read when unsure"
          description="Reads a doubtful ad again"
          control={
            <Toggle
              label="Second read when unsure"
              checked={form.escalationOn}
              onChange={(escalationOn) => edit({ ...form, escalationOn })}
            />
          }
        />
        <SettingRow
          layout="field"
          title="Second read model"
          control={
            <div className="adv-pair">
              <ModelSelect
                label="Second read model"
                models={models}
                value={form.escalationModel}
                disabled={!form.escalationOn}
                onChange={changeEscalationModel}
              />
              <EffortSelect
                label="Second read effort"
                efforts={effortsOf(form.prices, form.escalationModel)}
                value={form.escalationEffort}
                disabled={!form.escalationOn}
                onChange={(escalationEffort) => edit({ ...form, escalationEffort })}
              />
            </div>
          }
        />
        <SettingRow
          title="Always read in batches"
          description="Half price, results within an hour"
          control={
            <Toggle
              label="Always read in batches"
              checked={form.batchOnly}
              onChange={(batchOnly) => edit({ ...form, batchOnly })}
            />
          }
        />
      </div>

      <PriceTable form={form} onChange={edit} />

      {saving.state.status === "failed" && <Notice tone="alarm">{saving.state.message}</Notice>}
      {dirty ? (
        <Actions>
          <Button type="submit" variant="primary" size="sm" disabled={saving.busy}>
            Save reading model
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={saving.busy}
            onClick={() => {
              setForm(saved);
              settle();
            }}
          >
            Revert
          </Button>
          <Note>Unsaved changes</Note>
        </Actions>
      ) : (
        saving.state.status === "done" && <Note role="status">{saving.state.message}</Note>
      )}
    </form>
  );
}

export function AnalysisSection({
  api,
  stored,
  onSaved,
}: {
  api: ApiClient;
  stored: Doc<AnalysisSettings>;
  onSaved: (settings: Doc<AnalysisSettings>) => void;
}) {
  return (
    <Section title="Reading model">
      <ReanalysisPanel />
      <Form api={api} stored={stored} onSaved={onSaved} />
    </Section>
  );
}
