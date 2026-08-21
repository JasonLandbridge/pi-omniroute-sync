import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { Input } from "@oh-my-pi/pi-tui/components/input";
import { matchesKey } from "@oh-my-pi/pi-tui/keys";
import type { OmniPI } from "./contracts.ts";
import { createOmniExtension } from "./extension.ts";

export default async function (pi: ExtensionAPI): Promise<void> {
	await createOmniExtension(pi as unknown as OmniPI, {
		homeEnvVar: "OMP_HOME",
		defaultHome: "~/.omp/agent",
		matchesKey,
		createInput: (initialValue) => {
			const input = new Input();
			input.setValue(initialValue);
			return input;
		},
	});
}
