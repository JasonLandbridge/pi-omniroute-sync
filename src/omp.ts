import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { OmpInput, matchesOmpKey } from "./omp-input.ts";
import type { OmniPI } from "./contracts.ts";
import { createOmniExtension } from "./extension.ts";

export default async function (pi: ExtensionAPI): Promise<void> {
	await createOmniExtension(pi as unknown as OmniPI, {
		homeEnvVar: "OMP_HOME",
		defaultHome: "~/.omp/agent",
		host: "omp",
		inferenceApi: "openai-completions",
		matchesKey: matchesOmpKey,
		createInput: (initialValue) => new OmpInput(initialValue),
	});
}
