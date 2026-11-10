// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { ChipGroup, DateField, NumberField, SelectField, SelectPill } from "../src/ui/controls.js";
import { formatDay } from "../src/ui/DateField.js";
import { choose, chosenLabel, pickDay } from "./choose.js";
import "./render.js";

const FRUIT = [
  { value: "apple", label: "Apple" },
  { value: "banana", label: "Banana" },
  { value: "cherry", label: "Cherry" },
];

function Select({ pill = false }: { pill?: boolean }) {
  const [value, setValue] = useState("apple");
  return pill ? (
    <SelectPill label="Fruit" value={value} options={FRUIT} onChange={setValue} />
  ) : (
    <SelectField label="Fruit" value={value} options={FRUIT} onChange={setValue} />
  );
}

describe("SelectField", () => {
  it("is a combobox named by its label, with no native select", () => {
    render(<Select />);
    const box = screen.getByRole("combobox", { name: "Fruit" });
    expect(chosenLabel(box)).toBe("Apple");
    expect(document.querySelector("select")).toBeNull();
  });

  it("opens a listbox and picks with the mouse", async () => {
    const user = userEvent.setup();
    render(<Select />);
    const box = screen.getByRole("combobox", { name: "Fruit" });
    await choose(user, box, "Cherry");
    expect(chosenLabel(box)).toBe("Cherry");
    expect(box.getAttribute("aria-expanded")).toBe("false");
  });

  it("works from the keyboard: arrows, Enter, Escape and typing", async () => {
    const user = userEvent.setup();
    render(<Select />);
    const box = screen.getByRole("combobox", { name: "Fruit" });
    box.focus();
    await user.keyboard("{ArrowDown}");
    expect(box.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("option", { selected: true }).textContent).toBe("Apple");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(chosenLabel(box)).toBe("Banana");
    await user.keyboard("{ArrowDown}{End}{Escape}");
    expect(chosenLabel(box)).toBe("Banana");
    expect(box.getAttribute("aria-expanded")).toBe("false");
    await user.keyboard("c{Enter}");
    expect(chosenLabel(box)).toBe("Cherry");
    expect(document.activeElement).toBe(box);
  });

  it("closes on a press outside", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Select />
        <p>Elsewhere</p>
      </>,
    );
    const box = screen.getByRole("combobox", { name: "Fruit" });
    await user.click(box);
    expect(screen.getByRole("listbox")).toBeTruthy();
    await user.click(screen.getByText("Elsewhere"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("SelectPill", () => {
  it("opens the same listbox", async () => {
    const user = userEvent.setup();
    render(<Select pill />);
    const pill = screen.getByRole("combobox", { name: "Fruit" });
    await choose(user, pill, "Banana");
    expect(chosenLabel(pill)).toBe("Banana");
  });
});

function Day({ min }: { min?: string }) {
  const [value, setValue] = useState<string | null>("2026-12-01");
  return (
    <>
      <DateField label="Move in from" value={value} onChange={setValue} {...(min && { min })} />
      <output>{value ?? "none"}</output>
    </>
  );
}

describe("DateField", () => {
  it("shows the day as people say it, with no date input", () => {
    render(<Day />);
    expect(screen.getByRole("button", { name: "Move in from" }).textContent).toContain("1 Dec");
    expect(document.querySelector('input[type="date"]')).toBeNull();
  });

  it("picks a day from its calendar", async () => {
    const user = userEvent.setup();
    render(<Day />);
    await pickDay(user, screen.getByRole("button", { name: "Move in from" }), "15 January 2027");
    expect(document.querySelector("output")?.textContent).toBe("2027-01-15");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("moves by keys and picks with Enter; Escape closes", async () => {
    const user = userEvent.setup();
    render(<Day />);
    const field = screen.getByRole("button", { name: "Move in from" });
    await user.click(field);
    expect(document.activeElement?.getAttribute("data-day")).toBe("2026-12-01");
    await user.keyboard("{ArrowRight}{ArrowDown}{Enter}");
    expect(document.querySelector("output")?.textContent).toBe("2026-12-09");
    expect(document.activeElement).toBe(field);
    await user.click(field);
    await user.keyboard("{PageDown}{Escape}");
    expect(document.querySelector("output")?.textContent).toBe("2026-12-09");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("clears, and keeps days before `min` out of reach", async () => {
    const user = userEvent.setup();
    render(<Day min="2026-11-20" />);
    await user.click(screen.getByRole("button", { name: "Move in from" }));
    await user.click(screen.getByRole("button", { name: "Previous month" }));
    expect(
      (screen.getByRole("button", { name: "19 November 2026" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(document.querySelector("output")?.textContent).toBe("none");
  });

  it("formats this year's days short and others with the year", () => {
    const now = { y: 2026, m: 10, d: 7 };
    expect(formatDay("2026-12-01", now)).toBe("1 Dec");
    expect(formatDay("2027-04-01", now)).toBe("1 Apr 2027");
  });
});

function Chips() {
  const [chosen, setChosen] = useState<string[]>(["cherry"]);
  return (
    <>
      <ChipGroup legend="Fruit" options={FRUIT} chosen={chosen} onChange={setChosen} />
      <output>{chosen.join(",")}</output>
    </>
  );
}

function Rent() {
  const [value, setValue] = useState<number | null>(500);
  return (
    <>
      <NumberField label="Most you'll pay" prefix="€" value={value} onChange={setValue} max={501} />
      <output>{String(value)}</output>
    </>
  );
}

describe("ChipGroup", () => {
  it("ticks chips on and off, keeping the options' order", async () => {
    const user = userEvent.setup();
    render(<Chips />);
    expect(screen.getByRole("group", { name: "Fruit" })).toBeTruthy();
    await user.click(screen.getByRole("checkbox", { name: "Apple" }));
    expect(document.querySelector("output")?.textContent).toBe("apple,cherry");
    await user.click(screen.getByRole("checkbox", { name: "Cherry" }));
    expect(screen.getByRole("checkbox", { name: "Cherry" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
  });
});

describe("NumberField", () => {
  it("is a text field with its unit, stepped by the arrow keys", async () => {
    const user = userEvent.setup();
    render(<Rent />);
    const field = screen.getByRole("textbox", { name: "Most you'll pay" });
    expect(field.getAttribute("type")).toBe("text");
    expect(screen.getByText("€")).toBeTruthy();
    field.focus();
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(document.querySelector("output")?.textContent).toBe("501");
    await user.clear(field);
    expect(document.querySelector("output")?.textContent).toBe("null");
    await user.type(field, "12,5");
    expect(document.querySelector("output")?.textContent).toBe("12.5");
    await user.type(field, "x");
    expect(document.querySelector("output")?.textContent).toBe("12.5");
  });
});
