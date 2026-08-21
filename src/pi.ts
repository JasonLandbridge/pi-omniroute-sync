import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey } from "@earendil-works/pi-tui";
import type { OmniPI } from "./contracts.ts";
import { createOmniExtension } from "./extension.ts";

export default async function (pi: ExtensionAPI): Promise<void> {
	await createOmniExtension(pi as unknown as OmniPI, {
		homeEnvVar: "PI_HOME",
		defaultHome: "~/.pi/agent",
		matchesKey,
		createInput: (initialValue) => {
			const input = new Input();
			if (initialValue) input.handleInput(initialValue);
			return input;
		},
	});
}
