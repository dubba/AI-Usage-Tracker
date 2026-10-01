import { describe, expect, it } from "vitest";
import { appendAlert, MAX_VISIBLE_ALERTS, type UsageAlertToast } from "./usage-alerts";

const toast = (id: string): UsageAlertToast => ({ id, title: id, body: "", timestamp: 0 });

describe("appendAlert", () => {
  it("appends in arrival order", () => {
    expect(appendAlert([toast("a")], toast("b")).map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("drops the oldest toast once the cap is exceeded", () => {
    let list: UsageAlertToast[] = [];
    for (let i = 1; i <= MAX_VISIBLE_ALERTS + 2; i++) list = appendAlert(list, toast(String(i)));
    expect(list.map((t) => t.id)).toEqual(["3", "4", "5", "6", "7"]);
  });

  it("does not mutate its input", () => {
    const list = [toast("a")];
    appendAlert(list, toast("b"));
    expect(list).toHaveLength(1);
  });
});
