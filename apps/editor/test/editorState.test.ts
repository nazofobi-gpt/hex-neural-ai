import { describe, expect, it } from "vitest";
import { EditorState } from "../src/editorState";

describe("EditorState", () => {
  it("rejects coordinate collisions and supports deterministic undo/redo", () => {
    const state = new EditorState([
      { id: "a", label: "A", q: 0, r: 0 },
      { id: "b", label: "B", q: 1, r: 0 },
    ]);

    expect(state.move("a", { q: 1, r: 0 })).toBe(false);
    expect(state.move("a", { q: 0, r: 1 })).toBe(true);
    expect(state.nodes.find((node) => node.id === "a")).toMatchObject({
      q: 0,
      r: 1,
    });

    expect(state.undo()).toBe(true);
    expect(state.nodes.find((node) => node.id === "a")).toMatchObject({
      q: 0,
      r: 0,
    });

    expect(state.redo()).toBe(true);
    expect(state.nodes.find((node) => node.id === "a")).toMatchObject({
      q: 0,
      r: 1,
    });
  });

  it("adds and removes nodes without overwriting occupied coordinates", () => {
    const state = new EditorState([{ id: "a", label: "A", q: 0, r: 0 }]);

    expect(state.addAt({ q: 0, r: 0 })).toBeNull();
    const added = state.addAt({ q: 1, r: 0 });
    expect(added).not.toBeNull();
    expect(state.nodes).toHaveLength(2);

    expect(state.remove(added!.id)).toBe(true);
    expect(state.nodes).toHaveLength(1);
  });
});
