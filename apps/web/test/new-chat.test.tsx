import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppModel } from "../src/state/app-model";
import { AppModelProvider, useAppSnapshot } from "../src/state/use-app-model";
import { NewChatView } from "../src/components/NewChatView";
import { SidebarView } from "../src/components/SidebarView";
import { ComposerView } from "../src/components/ComposerView";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** The chat shell as RootView mounts it: the field only exists while open. */
function Shell() {
  const snapshot = useAppSnapshot();
  return (
    <>
      <SidebarView />
      {snapshot.isNewChatPresented ? <NewChatView /> : null}
    </>
  );
}

function newChat() {
  const model = new AppModel({ healthPollMs: 0 });
  model.openNewChat();
  render(<AppModelProvider model={model}><Shell /></AppModelProvider>);
  return model;
}

it("the To field greets you with the roster, not a modal form", async () => {
  newChat();
  expect(screen.getByRole("listbox", { name: "Start a chat" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: /New agent/ })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: /Agni Bot/ })).toBeInTheDocument();
  const input = screen.getByRole("combobox");
  await waitFor(() => expect(input).toHaveFocus());
});

it("the composer keeps no permanent recipient row", () => {
  const model = new AppModel({ healthPollMs: 0 });
  const { container } = render(<AppModelProvider model={model}><ComposerView /></AppModelProvider>);
  expect(container.querySelector(".new-chat")).toBeNull();
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
});

it("arrow keys pick the agent under the cursor and close the field", () => {
  const model = newChat();
  const select = vi.spyOn(model, "selectAgent").mockImplementation(() => undefined);
  const input = screen.getByRole("combobox");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(select).toHaveBeenCalledWith(expect.objectContaining({ id: "ea" }));
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
});

it("making an agent happens in the same top panel", () => {
  const model = newChat();
  const create = vi.spyOn(model, "createAgent").mockImplementation(() => undefined);
  fireEvent.click(screen.getByRole("option", { name: /New agent/ }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "FRIDAY" } });
  fireEvent.change(screen.getByLabelText("Tag"), { target: { value: "inbox manager" } });
  fireEvent.change(screen.getByLabelText("What it should do"), { target: { value: "You read my inbox." } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(create).toHaveBeenCalledWith({ name: "FRIDAY", role: "inbox manager", prompt: "You read my inbox." });
  expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
});

it("the roster's + opens the same field", () => {
  const model = new AppModel({ healthPollMs: 0 });
  render(<AppModelProvider model={model}><Shell /></AppModelProvider>);
  fireEvent.click(screen.getByLabelText("Start a new chat"));
  expect(screen.getByRole("listbox", { name: "Start a chat" })).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("Open Agni Bot chat"));
  expect(screen.queryByRole("listbox", { name: "Start a chat" })).not.toBeInTheDocument();
});

it("query narrows the roster and keeps New agent reachable", () => {
  newChat();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "zzz" } });
  expect(screen.getByRole("option", { name: /New agent/ })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: /Agni Bot/ })).not.toBeInTheDocument();
  expect(screen.getByText(/No agents match/)).toBeInTheDocument();
});
