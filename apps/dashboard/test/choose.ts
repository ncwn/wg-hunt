import { screen, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

export async function choose(user: UserEvent, combobox: HTMLElement, option: string) {
  await user.click(combobox);
  const id = combobox.getAttribute("aria-controls");
  const list = id ? document.getElementById(id) : null;
  if (!list) throw new Error("The select did not open its listbox");
  await user.click(within(list).getByRole("option", { name: option }));
}

export const chosenLabel = (combobox: HTMLElement) =>
  combobox.querySelector(".wh-field-value, .wh-select-value")?.textContent ?? "";

export async function pickDay(user: UserEvent, field: HTMLElement, day: string) {
  await user.click(field);
  const dialog = screen.getByRole("dialog");
  const [d, month, year] = day.split(" ");
  const heading = `${month} ${year}`;
  for (let i = 0; i < 48 && !within(dialog).queryByText(heading); i++) {
    const back =
      new Date(`${month} 1, ${year}`) <
      new Date(within(dialog).getByText(/\d{4}$/).textContent ?? "");
    await user.click(
      within(dialog).getByRole("button", { name: back ? "Previous month" : "Next month" }),
    );
  }
  await user.click(within(dialog).getByRole("button", { name: `${d} ${month} ${year}` }));
}

export async function optionsOf(user: UserEvent, combobox: HTMLElement) {
  await user.click(combobox);
  const id = combobox.getAttribute("aria-controls");
  const list = id ? document.getElementById(id) : null;
  if (!list) throw new Error("The select did not open its listbox");
  const labels = within(list)
    .getAllByRole("option")
    .map((option) => option.firstElementChild?.firstElementChild?.textContent ?? "");
  await user.keyboard("{Escape}");
  return labels;
}
