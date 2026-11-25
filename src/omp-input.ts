import type { OmniInput } from "./contracts.ts";

const keys: Record<string, string> = {
	"\r": "enter", "\n": "enter", "\t": "tab", "\x1b": "escape", " ": "space",
	"\x03": "ctrl+c", "\x15": "ctrl+u", "\x01": "home", "\x05": "end",
	"\x7f": "backspace", "\b": "backspace",
	"\x1b[A": "up", "\x1b[B": "down", "\x1b[C": "right", "\x1b[D": "left",
	"\x1bOA": "up", "\x1bOB": "down", "\x1bOC": "right", "\x1bOD": "left",
	"\x1b[Z": "shift+tab", "\x1b[H": "home", "\x1b[F": "end",
	"\x1bOH": "home", "\x1bOF": "end", "\x1b[1~": "home", "\x1b[4~": "end",
	"\x1b[3~": "delete",
};
const codeKeys: Record<number, string> = {
	9: "tab", 13: "enter", 27: "escape", 32: "space", 127: "backspace",
	57350: "left", 57351: "right", 57352: "up", 57353: "down",
	57417: "left", 57418: "right", 57419: "up", 57420: "down",
	57348: "delete", 57356: "home", 57357: "end",
};

// Rows receive raw terminal input in both OMP 19.1 and 19.2; no host TUI imports are needed.
function decodeKey(data: string): string {
	if (keys[data]) return keys[data];
	const arrow = /^\x1b\[1;(\d+)([ABCDHF])$/.exec(data);
	const kitty = /^\x1b\[(\d+)(?:;(\d+)(?::([123]))?)?(?:;[\d:]+)?u$/.exec(data);
	const modifyOther = /^\x1b\[27;(\d+);(\d+)~$/.exec(data);
	if (!arrow && !kitty && !modifyOther) return data;
	if (kitty?.[3] === "3") return "";
	const code = Number(kitty?.[1] ?? modifyOther?.[2]);
	const base = arrow ? keys[`\x1b[${arrow[2]}`] : codeKeys[code] ?? (code <= 0x10ffff ? String.fromCodePoint(code) : "");
	const modifiers = Number(arrow?.[1] ?? kitty?.[2] ?? modifyOther?.[1] ?? 1) - 1;
	if (modifiers === 1 && Array.from(base).length === 1) return base.toUpperCase();
	return `${modifiers & 4 ? "ctrl+" : ""}${modifiers & 2 ? "alt+" : ""}${modifiers & 1 ? "shift+" : ""}${base}`;
}

export function matchesOmpKey(data: string, key: string): boolean {
	return decodeKey(data) === key;
}

export class OmpInput implements OmniInput {
	onSubmit?: (value: string) => void;
	onEscape?: () => void;
	private value: string[] = [];
	private cursor = 0;
	private paste: string | undefined;

	constructor(initialValue: string) {
		this.setValue(initialValue);
	}

	getValue(): string { return this.value.join(""); }
	setValue(value: string): void {
		this.value = Array.from(value);
		this.cursor = this.value.length;
	}
	invalidate(): void {}

	handleInput(data: string): void {
		if (this.paste !== undefined || data.includes("\x1b[200~")) {
			const text = (this.paste ?? "") + data.replace("\x1b[200~", "");
			const end = text.indexOf("\x1b[201~");
			if (end < 0) { this.paste = text; return; }
			this.paste = undefined;
			this.insert(text.slice(0, end));
			const rest = text.slice(end + 6);
			if (rest) this.handleInput(rest);
			return;
		}
		const key = decodeKey(data);
		switch (key) {
			case "enter": this.onSubmit?.(this.getValue()); return;
			case "escape": this.onEscape?.(); return;
			case "ctrl+u": this.value.splice(0, this.cursor); this.cursor = 0; return;
			case "home": this.cursor = 0; return;
			case "end": this.cursor = this.value.length; return;
			case "left": this.cursor = Math.max(0, this.cursor - 1); return;
			case "right": this.cursor = Math.min(this.value.length, this.cursor + 1); return;
			case "backspace": if (this.cursor) this.value.splice(--this.cursor, 1); return;
			case "delete": this.value.splice(this.cursor, 1); return;
		}
		if (key === "space") this.insert(" ");
		else if (Array.from(key).length === 1 && !/[\x00-\x1f\x7f-\x9f]/.test(key)) this.insert(key);
		else if (!data.startsWith("\x1b") && key === data) this.insert(data);
	}

	private insert(text: string): void {
		const chars = Array.from(text.replace(/[\x00-\x1f\x7f-\x9f]/g, ""));
		this.value.splice(this.cursor, 0, ...chars);
		this.cursor += chars.length;
	}

	render(width: number): string[] {
		const available = Math.max(0, width - 2);
		if (!available) return ["".padEnd(Math.max(0, width))];
		// Reserve two terminal columns per code point so wide text stays inside the frame.
		const slots = Math.floor(available / 2);
		if (!slots) return ["> ".slice(0, width)];
		const start = Math.max(0, this.cursor - slots + 1);
		const before = this.value.slice(start, this.cursor).join("");
		const cursor = this.value[this.cursor] ?? " ";
		const after = this.value.slice(this.cursor + 1, start + slots).join("");
		return [`> ${before}\x1b[7m${cursor}\x1b[27m${after}`];
	}
}
