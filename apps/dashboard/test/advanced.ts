import { screen } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

export async function openAdvanced(user: UserEvent) {
  await screen.findByRole("heading", { level: 1, name: "Settings" });
  await openFold(user, "Advanced");
}

export async function openFold(user: UserEvent, title: string) {
  const head = await screen.findByRole("button", { name: new RegExp(`^${title}`) });
  if (head.getAttribute("aria-expanded") !== "true") await user.click(head);
}
