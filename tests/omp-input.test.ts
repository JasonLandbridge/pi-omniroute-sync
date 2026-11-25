import { describe, expect, it, vi } from "vitest";
import { OmpInput, matchesOmpKey } from "../src/omp-input.ts";

describe("OMP terminal input across host versions", () => {
	it.each([
		["up", ["\x1b[A", "\x1bOA", "\x1b[57419u", "\x1b[1;1A", "\x1b[57352u"]],
		["down", ["\x1b[B", "\x1bOB", "\x1b[57420u", "\x1b[1;1B"]],
		["left", ["\x1b[D", "\x1bOD", "\x1b[57417u", "\x1b[1;1D"]],
		["right", ["\x1b[C", "\x1bOC", "\x1b[57418u", "\x1b[1;1C"]],
		["escape", ["\x1b", "\x1b[27u", "\x1b[27;1;27~"]],
		["enter", ["\r", "\x1b[13u"]],
		["shift+tab", ["\x1b[Z", "\x1b[9;2u"]],
		["ctrl+c", ["\x03", "\x1b[99;5u"]],
	] as const)("recognizes %s in legacy and extended keyboard protocols", (key, sequences) => {
		for (const sequence of sequences) expect(matchesOmpKey(sequence, key)).toBe(true);
	});

	it("edits at the cursor without splitting supplementary Unicode characters", () => {
		const input = new OmpInput("a😀c");
		input.handleInput("\x1b[D");
		input.handleInput("\x7f");
		input.handleInput("b");
		expect(input.getValue()).toBe("abc");
		input.handleInput("\x01");
		input.handleInput("\x1b[3~");
		expect(input.getValue()).toBe("bc");
		input.handleInput("\x05");
		input.handleInput("\x15");
		expect(input.getValue()).toBe("");
	});

	it("inserts bracketed paste without submitting or injecting terminal controls", () => {
		const input = new OmpInput("");
		const submit = vi.fn();
		input.onSubmit = submit;
		input.handleInput("\x1b[200~http://local");
		input.handleInput("host:20128\n\x1b[201~");
		expect(input.getValue()).toBe("http://localhost:20128");
		expect(submit).not.toHaveBeenCalled();
		input.handleInput("\r");
		expect(submit).toHaveBeenCalledWith("http://localhost:20128");
	});

	it("handles extended printable input and ignores release events", () => {
		const input = new OmpInput("");
		input.handleInput("\x1b[97u");
		input.handleInput("\x1b[97;1:3u");
		input.handleInput("\x1b[32u");
		input.handleInput("b");
		expect(input.getValue()).toBe("a b");
	});

	it("cancels edits without submitting and bounds long rendered ASCII input", () => {
		const input = new OmpInput("a".repeat(100));
		const escape = vi.fn();
		const submit = vi.fn();
		input.onEscape = escape;
		input.onSubmit = submit;
		input.handleInput("\x1b[27u");
		expect(escape).toHaveBeenCalledOnce();
		expect(submit).not.toHaveBeenCalled();
		expect(input.render(20)[0].replace(/\x1b\[[0-9;]*m/g, "").length).toBeLessThanOrEqual(20);
	});
});
