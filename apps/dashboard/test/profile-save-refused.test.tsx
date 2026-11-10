// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { preview } from "./profile-harness.js";
import { realServer } from "./real-server.js";
import { renderDashboard } from "./render.js";

const REFUSALS = [
  {
    status: 400,
    body: {
      type: "validation-error",
      title: "Invalid request",
      status: 400,
      detail: "The distance Filter measures from a Place that the Seeker Profile does not have.",
      errors: [
        {
          path: "filters.distance.place",
          message: "The Seeker Profile has no Place with this name",
        },
      ],
    },
  },
  {
    status: 500,
    body: {
      type: "internal-error",
      title: "Server error",
      status: 500,
      detail: "The disk is busy.",
    },
  },
];

describe("Profile & Filters: a save the server refuses", () => {
  it.each(REFUSALS)(
    "keeps the draft and what was loaded, and says nothing was saved ($status)",
    async (refusal) => {
      const server = realServer({ signedIn: true });
      await server.ready;
      let refusing = true;
      const fetch = async (request: Request) =>
        refusing && request.method === "PUT" && new URL(request.url).pathname.endsWith("/seeking")
          ? new Response(JSON.stringify(refusal.body), {
              status: refusal.status,
              headers: { "Content-Type": "application/problem+json" },
            })
          : server.fetch(request);
      const { user } = renderDashboard(fetch, "/profile");
      const limit = (await screen.findByLabelText("Max warm rent limit")) as HTMLInputElement;
      await user.type(limit, "480");
      await within(preview()).findByText(/would be ranked differently/);
      const save = within(preview()).getByRole("button", { name: "Save" });
      await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
      await user.click(save);

      const said = await within(preview()).findByText(/^Nothing was saved: /);
      expect(said.textContent).toContain(refusal.body.detail);
      expect(limit.value).toBe("480");
      const nav = within(screen.getByRole("navigation", { name: "Main" }));
      expect(nav.getByRole("img", { name: "Unsaved draft" })).toBeTruthy();
      expect((await (await server.asCli("/filters")).json()).maxRent.limit).toBeNull();

      await user.clear(limit);
      await waitFor(() => expect(nav.queryByRole("img", { name: "Unsaved draft" })).toBeNull());

      refusing = false;
      await user.type(limit, "480");
      await within(preview()).findByText(/would be ranked differently/);
      const again = within(preview()).getByRole("button", { name: "Save" });
      await waitFor(() => expect((again as HTMLButtonElement).disabled).toBe(false));
      await user.click(again);
      expect(await screen.findByText(/Saved\. Your Offers are already ranked/)).toBeTruthy();
      expect((await (await server.asCli("/filters")).json()).maxRent.limit).toBe(480);
    },
  );
});
