import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { Input, matchesKey } from "@earendil-works/pi-tui";
import type { OmniPI } from "./contracts.ts";
import { createOmniExtension } from "./extension.ts";

export default async function (pi: ExtensionAPI): Promise<void> {
	await createOmniExtension(pi as unknown as OmniPI, {
		homeEnvVar: "OMP_HOME",
		defaultHome: "~/.omp/agent",
		inferenceApi: "openai-completions",
		matchesKey,
		createInput: (initialValue) => {
			const input = new Input();
			input.setValue(initialValue);
			return input;
		},
	});
}
