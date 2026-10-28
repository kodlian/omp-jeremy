import { createHash } from "node:crypto";
import { extname } from "node:path";
import type { Pointer } from "bun:ffi";
import { dlopen, ptr, read } from "bun:ffi";

export interface LocalFont {
	id: string;
	family: string;
	postscriptName: string;
	path: string;
}

type FontLookup = (family: string) => Omit<LocalFont, "id"> | null;
let macFont: FontLookup | undefined;
const fonts = new Map<string, LocalFont>();

function loadCoreText(): FontLookup {
	const { symbols: cf } = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
		CFStringCreateWithCString: { args: ["ptr", "ptr", "u32"], returns: "ptr" },
		CFStringGetCString: { args: ["ptr", "ptr", "i64", "u32"], returns: "bool" },
		CFURLGetFileSystemRepresentation: { args: ["ptr", "bool", "ptr", "i64"], returns: "bool" },
		CFRelease: { args: ["ptr"], returns: "void" },
	});
	const { symbols: ct } = dlopen("/System/Library/Frameworks/CoreText.framework/CoreText", {
		CTFontCreateWithName: { args: ["ptr", "f64", "ptr"], returns: "ptr" },
		CTFontCopyFamilyName: { args: ["ptr"], returns: "ptr" },
		CTFontCopyFullName: { args: ["ptr"], returns: "ptr" },
		CTFontCopyPostScriptName: { args: ["ptr"], returns: "ptr" },
		CTFontCopyAttribute: { args: ["ptr", "ptr"], returns: "ptr" },
	});
	const dyld = dlopen("/usr/lib/libSystem.B.dylib", { dlsym: { args: ["i64", "ptr"], returns: "ptr" } });
	// RTLD_DEFAULT finds CoreText's exported CFString constant.
	const symbol = dyld.symbols.dlsym(-2, ptr(Buffer.from("kCTFontURLAttribute\0")));
	const urlAttribute = read.ptr(symbol!);
	return (family) => {
		const refs: Pointer[] = [];
		try {
			const name = cf.CFStringCreateWithCString(null, ptr(Buffer.from(`${family}\0`)), 0x08000100)!;
			refs.push(name);
			const font = ct.CTFontCreateWithName(name, 0, null)!;
			refs.push(font);
			const names = [ct.CTFontCopyFamilyName(font)!, ct.CTFontCopyPostScriptName(font)!, ct.CTFontCopyFullName(font)!];
			refs.push(...names);
			const buffer = Buffer.alloc(4096);
			const decoded = names.map((value) => {
				if (!cf.CFStringGetCString(value, ptr(buffer), buffer.length, 0x08000100)) return "";
				return buffer.toString("utf8", 0, buffer.indexOf(0));
			});
			// CoreText substitutes Helvetica for an unknown font; try the next configured family instead.
			if (!decoded.some((value) => value.toLowerCase() === family.toLowerCase())) return null;
			const url = ct.CTFontCopyAttribute(font, urlAttribute);
			if (!url) return null;
			refs.push(url);
			if (!cf.CFURLGetFileSystemRepresentation(url, true, ptr(buffer), buffer.length)) return null;
			return { family: decoded[0], postscriptName: decoded[1], path: buffer.toString("utf8", 0, buffer.indexOf(0)) };
		} finally {
			for (const ref of refs) cf.CFRelease(ref);
		}
	};
}

export async function terminalFont(families: string[]): Promise<LocalFont | null> {
	for (const family of families) {
		const cached = fonts.get(family);
		if (cached) return cached;
		try {
			let font: Omit<LocalFont, "id"> | null;
			if (process.platform === "darwin") font = (macFont ??= loadCoreText())(family);
			else {
				const proc = Bun.spawn(["fc-match", "--format=%{family}\n%{postscriptname}\n%{file}", family], { stdout: "pipe", stderr: "ignore", timeout: 2000 });
				const [matched, postscriptName, path] = (await new Response(proc.stdout).text()).split("\n");
				if ((await proc.exited) !== 0 || !matched.split(",").some((value) => value.toLowerCase() === family.toLowerCase())) continue;
				font = { family: matched, postscriptName, path };
			}
			if (!font || ![".ttf", ".otf", ".ttc", ".otc", ".woff", ".woff2"].includes(extname(font.path).toLowerCase())) continue;
			const resolved = { ...font, id: createHash("sha256").update(`${font.path}#${font.postscriptName}`).digest("hex").slice(0, 16) };
			fonts.set(family, resolved);
			return resolved;
		} catch {}
	}
	return null;
}
