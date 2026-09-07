import { beforeEach, describe, expect, it, vi } from "vitest";

const { createOmniExtension, PiInput } = vi.hoisted(() => {
	class Input {
		private value = "";
		handleInput(value: string) { this.value += value; }
		setValue(value: string) { this.value = value; }
		getValue() { return this.value; }
	}
	return { createOmniExtension: vi.fn(async () => undefined), PiInput: Input };
});
vi.mock("../src/extension.ts", () => ({ createOmniExtension }));
vi.mock("@earendil-works/pi-tui", () => ({ Input: PiInput, matchesKey: (data: string, key: string) => data === "\r" && key === "enter" }));

import ompExtension from "../src/omp.ts";
import piExtension from "../src/pi.ts";

describe("host adapters", () => {
	beforeEach(() => createOmniExtension.mockClear());

	it("loads and configures the Pi adapter", async () => {
		const pi = {};
		await piExtension(pi as never);

		expect(createOmniExtension).toHaveBeenCalledOnce();
		const [received, options] = createOmniExtension.mock.calls[0];
		expect(received).toBe(pi);
		expect(options).toMatchObject({ homeEnvVar: "PI_HOME", defaultHome: "~/.pi/agent" });
		expect(options.matchesKey("\r", "enter")).toBe(true);
		expect(options.createInput("initial").getValue()).toBe("initial");
	});

	it("loads and configures the OMP adapter", async () => {
		const pi = {};
		await ompExtension(pi as never);

		expect(createOmniExtension).toHaveBeenCalledOnce();
		const [received, options] = createOmniExtension.mock.calls[0];
		expect(received).toBe(pi);
		expect(options).toMatchObject({ homeEnvVar: "OMP_HOME", defaultHome: "~/.omp/agent", inferenceApi: "openai-completions" });
		expect(options.matchesKey("\r", "enter")).toBe(true);
		expect(options.createInput("initial").getValue()).toBe("initial");
	});
});
