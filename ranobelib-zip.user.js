// ==UserScript==
// @name         Archive ranobe (streaming)
// @namespace    https://github.com/QRANG/ranobelib-epub-userscript
// @version      2026.09.13
// @description  Download ranobe from ranobelib.me as archived zip. Streams directly to disk, constant memory usage.
// @author       X4, QRANG
// @license      MIT
// @homepageURL  https://github.com/QRANG/ranobelib-epub-userscript
// @supportURL   https://github.com/QRANG/ranobelib-epub-userscript/issues
// @downloadURL  https://raw.githubusercontent.com/QRANG/ranobelib-epub-userscript/main/ranobelib-zip.user.js
// @updateURL    https://raw.githubusercontent.com/QRANG/ranobelib-epub-userscript/main/ranobelib-zip.user.js
// @match        https://ranobelib.me/*book/*
// @icon         https://icons.duckduckgo.com/ip2/ranobelib.me.ico
// @require      https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.7.57/dist/zip.min.js
// @grant        none
// ==/UserScript==

(() => {
	"use strict";

	// ------------------------------------------------------------------ config

	const CONFIG = {
		compression_level: 9,	// 0..9, 0 = store only (much faster, bigger file)
		chapters_per_pause: 100,	// ratelimit pacing: pause after this many chapters
		pause_ms: 60_000,
		image_retries: 2,
		use_web_workers: true,	// auto-disabled if the page CSP blocks worker blobs
	};

	// ----------------------------------------------------------------- helpers

	const create_element = (tag, attrs) => attrs ? Object.assign(document.createElement(tag), attrs) : document.createElement(tag);

	const delay = time => new Promise(resolve => setTimeout(resolve, time));

	const unix_timestamp = () => Math.floor(new Date().getTime() / 1_000);

	// Kept identical to reader.js so that generated links always match filenames.
	const pad_number = n => {
		const v = typeof n === "number" ? n : (Number.isFinite(+n) && `${n}`.trim() !== "" ? +n : n);
		return typeof v === "number" ? v.toLocaleString("en-US", { minimumIntegerDigits: 3, useGrouping: false }) : `${v}`;
	};

	const chapter_tag = ch => `v${ch.volume}_${pad_number(ch.number)}`;

	const fetch_json = async (url) => {
		try {
			const resp = await fetch(url, { method: "GET" });

			if (resp.status === 429) {
				const reset_at = resp.headers.has("X-Ratelimit-Reset") ? +resp.headers.get("X-Ratelimit-Reset") : unix_timestamp() + 60,
					dt = Math.max(1, reset_at - unix_timestamp());

				console.warn(`Waiting ${dt} seconds for ratelimit reset for url: ${url}`);

				await delay(dt * 1_000);
				return await fetch_json(url);
			}
			if (!resp.ok) return;

			return await resp.json();
		} catch (e) {
			console.error(`Fetch error: ${url}\n`, e);
		}
	};

	const fetch_blob = async (url, retries = CONFIG.image_retries) => {
		for (let attempt = 0; attempt <= retries; ++attempt) {
			try {
				const resp = await fetch(url, { method: "GET" });

				if (resp.status === 429) {
					const reset_at = resp.headers.has("X-Ratelimit-Reset") ? +resp.headers.get("X-Ratelimit-Reset") : unix_timestamp() + 60,
						dt = Math.max(1, reset_at - unix_timestamp());

					await delay(dt * 1_000);
					--attempt;
					continue;
				}
				if (!resp.ok) return;

				return await resp.blob();
			} catch (e) {
				console.error(`Fetch error (attempt ${attempt + 1}): ${url}\n`, e);
				if (attempt < retries) await delay(2_000 * (attempt + 1));
			}
		}
	};

	const fetch_chapters = async (slug) => (await fetch_json(`https://api.cdnlibs.org/api/manga/${slug}/chapters`))?.data;

	const fetch_chapter = async (slug, volume, number) => (await fetch_json(`https://api.cdnlibs.org/api/manga/${slug}/chapter?number=${number}&volume=${volume}`))?.data;

	const fetch_ranobe_data = async (slug) => (await fetch_json(`https://api.cdnlibs.org/api/manga/${slug}?fields[]=background&fields[]=eng_name&fields[]=otherNames&fields[]=summary&fields[]=releaseDate&fields[]=type_id&fields[]=caution&fields[]=views&fields[]=close_view&fields[]=rate_avg&fields[]=rate&fields[]=genres&fields[]=tags&fields[]=teams&fields[]=franchise&fields[]=authors&fields[]=publisher&fields[]=userRating&fields[]=moderated&fields[]=metadata&fields[]=metadata.count&fields[]=metadata.close_comments&fields[]=manga_status_id&fields[]=chap_count&fields[]=status_id&fields[]=artists&fields[]=format`))?.data;

	// ------------------------------------------------ shared archive resources
	// These live in ONE file each instead of being inlined into every chapter.
	// That is what turns the archive from O(n^2) back into O(n).

	const STYLE_CSS = `body {
	font-weight: 100;
	font-family: -webkit-pictograph;
	font-size: 18px;
	line-height: 1;
	text-align: center;
	word-break: break-word;
	margin: 0 auto;
	padding: 25px 5vw;
	background-color: hsl(223 9% 13% / 1);
	color: #dbdbdb;
	min-height: calc(100vh - 50px);
}

* {
	tab-size: 4 !important;
}

/* Firefox scrollbar, 8px */
@supports (-moz-appearance:none) {
	* {
		scrollbar-width: thin;
	}
}

/* Chrome scrollbar */
*::-webkit-scrollbar {
	width: 5px;
	height: 5px;
	background-color: transparent;
}
*::-webkit-scrollbar-thumb {
	background-color: #8888;
}
*::-webkit-scrollbar:hover {
	background-color: #8883;
}

h1 {
	line-height: 1.4;
	font-weight: 700;
	font-size: 24px;
}

p {
	margin-bottom: 12px;
	text-align: left;
}

a {
	display: block;
	user-select: none;
	color: inherit;
	text-decoration: none;
	border-radius: 10px;

	&:hover {
		background-color: #dbdbdb30;
	}

	&.prev {
		left: 5px;
	}

	&.next {
		right: 5px;
	}

	&.prev,
	&.next {
		position: fixed;
		bottom: 5px;
		width: 4vw;
		height: 30vh;
		font-size: 2vw;
		line-height: 30vh;
		border: 1px solid #dbdbdb;
		z-index: 5;
	}
}

nav {
	position: fixed;
	right: 0;
	bottom: 0;
	max-width: 520px;
	display: grid;
	padding: 10px 14px;
	gap: 2px;
	align-content: start;
	background-color: hsl(223 9.5% 22% / 0);
	text-align: left;
	font-weight: 500;
	font-size: 16px;
	max-height: 40px;
	overflow: hidden;
	z-index: 3;
	transition: .3s ease;

	&::before {
		content: "Оглавление";
		display: block;
		font-size: 20px;
		padding: 25px 15px 20px 15px;
		cursor: pointer;
		position: sticky;
		top: -10px;
	}

	&:focus-within {
		max-height: calc(100vh - 20px);
		overflow: auto;
		background-color: hsl(223 9.5% 22% / 1);
		z-index: 6;

		&::before {
			background-color: hsl(223 9.5% 22% / 1);
		}
	}

	> a {
		padding: 10px 14px;
	}

	> a:hover,
	> a.current {
		background-color: hsl(223 9.5% 13% / 0.3);
	}
}`;

	// Classic script (not a module) on purpose: file:// blocks module scripts,
	// but allows <script src> and <link rel=stylesheet> to sibling files.
	const READER_JS = `(function () {
	"use strict";

	var create_element = function (tag, attrs) { return attrs ? Object.assign(document.createElement(tag), attrs) : document.createElement(tag); };

	var pad_number = function (n) {
		var v = typeof n === "number" ? n : (isFinite(+n) && String(n).trim() !== "" ? +n : n);
		return typeof v === "number" ? v.toLocaleString("en-US", { minimumIntegerDigits: 3, useGrouping: false }) : String(v);
	};

	var href_of = function (ch) { return "v" + ch.volume + "_" + pad_number(ch.number) + ".html"; };

	var chapters = window.CHAPTERS || [],
		current_id = window.CURRENT_ID,
		idx = -1;

	for (var j = 0; j < chapters.length; ++j) if (chapters[j].id === current_id) { idx = j; break; }

	var prev = idx > 0 ? chapters[idx - 1] : null,
		next = idx >= 0 && idx < chapters.length - 1 ? chapters[idx + 1] : null;

	if (prev) document.body.appendChild(create_element("a", { className: "prev", href: href_of(prev), innerText: "\\u2190" }));
	if (next) document.body.appendChild(create_element("a", { className: "next", href: href_of(next), innerText: "\\u2192" }));

	var nav = create_element("nav", { tabIndex: "0" }),
		frag = document.createDocumentFragment();

	for (var i = 0; i < chapters.length; ++i) {
		var ch = chapters[i],
			cd = create_element("a", { innerText: "Том " + ch.volume + " Глава " + ch.number + " - " + (ch.name || ""), href: href_of(ch) });

		if (ch.id === current_id) cd.classList.add("current");

		frag.appendChild(cd);
	}

	nav.appendChild(frag);
	document.body.appendChild(nav);
})();`;

	const html_template = (title, head, body, current_id) => `<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>${title}</title>
	<link rel="stylesheet" href="../style.css" />
</head>
<body>
${head}
${body}
<script>window.CURRENT_ID = ${JSON.stringify(current_id)};</script>
<script src="../chapters.js"></script>
<script src="../reader.js"></script>
</body>
</html>`;

	// --------------------------------------------------------------- zip sinks

	// Preferred sink: write straight into a file the user picked. Memory stays flat
	// no matter how big the archive gets.
	const pick_file_sink = async (suggested_name) => {
		if (!window.showSaveFilePicker) return;

		try {
			const handle = await window.showSaveFilePicker({
				suggestedName: suggested_name,
				types: [{ description: "ZIP archive", accept: { "application/zip": [".zip"] } }],
			});

			return { writable: await handle.createWritable(), kind: "disk" };
		} catch (e) {
			if (e?.name === "AbortError") return null;	// user cancelled, distinct from "unsupported"
			console.warn("showSaveFilePicker failed, falling back to in-memory blob\n", e);
		}
	};

	// Fallback sink: a Blob. Still far better than base64 — browsers spill large
	// blobs onto disk instead of keeping them as JS strings.
	const blob_sink = () => {
		const writer = new zip.BlobWriter("application/zip");
		return { blob_writer: writer, kind: "blob" };
	};

	const probe_web_workers = async () => {
		if (!CONFIG.use_web_workers) return false;

		try {
			zip.configure({ useWebWorkers: true });
			const w = new zip.ZipWriter(new zip.BlobWriter("application/zip"), { level: 1 });
			await w.add("probe.txt", new zip.TextReader("probe"));
			await w.close();
			return true;
		} catch (e) {
			console.warn("Web workers unavailable (CSP?), compressing on the main thread\n", e);
			zip.configure({ useWebWorkers: false });
			return false;
		}
	};

	// --------------------------------------------------------------- main flow

	const get_attachment = (attachments, name) => attachments.find(a => a.name === name);

	const local_attachment = (attachments, name, tag) => {
		const attachment = get_attachment(attachments, name);
		if (!attachment) return "";

		return `../images/${tag}/${attachment.filename}`;
	};

	const build_chapter_html = (chapter, attachments, tag) => {
		if (typeof chapter.content === "string") {
			return chapter.content.replace(
				/(<img (?:[\w"=]+\s)*src=")https:\/\/ranobelib\.me\/[^"]+\/([^\/"]+)("(?:[\w"=]+\s|\s)*\/?>)/g,
				`$1../images/${tag}/$2$3`
			);
		}

		return (chapter.content?.content ?? []).map(o => {
			if (o.type === "paragraph") return `<p>${o?.content?.map?.(o2 => o2.text)?.join?.("<br />") ?? ""}</p>`;
			if (o.type === "image") return `<img alt="" src="${local_attachment(attachments, o?.attrs?.images?.[0]?.image, tag)}" />`;
			return `<p>${o?.text ?? ""}</p>`;
		}).join("");
	};

	const html_to_text = (title, curr, chapter, html) => {
		const doc = new DOMParser().parseFromString(html, "text/html"),
			body = [...doc.body.children]
				.map(c => c.tagName === "IMG" ? `[${c.getAttribute("src")}]\n\n` : `${c.textContent.replace(/\n/g, " ")}\n\n`)
				.join("");

		return `${title}\n\nТом ${curr.volume} Глава ${curr.number}${chapter.name ? " - " + chapter.name : ""}\n\n${body}`;
	};

	const dl_archive = async (btn) => {
		const slug = window.location.pathname.match(/(?<=book\/)[\w\-]+/)?.[0];
		if (!slug) return alert("Не удалось определить slug тайтла.");

		// Must run before any await: showSaveFilePicker needs transient user activation.
		const picked = await pick_file_sink(`${slug}.zip`);
		if (picked === null) return;	// cancelled

		const sink = picked ?? blob_sink(),
			set_status = text => { btn.innerText = text; btn.title = text; };

		set_status("…");

		const ranobe_data = await fetch_ranobe_data(slug),
			title = ranobe_data?.rus_name || ranobe_data?.name || slug,
			chapters = await fetch_chapters(slug);

		if (!chapters?.length) {
			set_status("📥");
			return alert("Не удалось получить список глав.");
		}

		// Strip the chapter list down to what the reader actually needs, and ship it
		// once as chapters.js instead of inlining the full API payload per chapter.
		const nav_list = chapters.map(c => ({ id: c.id, volume: c.volume, number: c.number, name: c.name ?? "" })),
			total = chapters.length,
			writer = new zip.ZipWriter(sink.writable ?? sink.blob_writer, {
				level: CONFIG.compression_level,
				zip64: true,		// > 4 GB / > 65535 entries
				bufferedWrite: false,	// stream each entry out instead of buffering it
			});

		let failed = 0;

		try {
			await writer.add("style.css", new zip.TextReader(STYLE_CSS));
			await writer.add("reader.js", new zip.TextReader(READER_JS));
			await writer.add("chapters.js", new zip.TextReader(`window.CHAPTERS = ${JSON.stringify(nav_list)};`));
			if (ranobe_data) await writer.add("info.json", new zip.TextReader(JSON.stringify(ranobe_data, null, "\t")));

			for (let i = 0; i < total; ++i) {
				const curr = chapters[i],
					tag = chapter_tag(curr);

				set_status(`${Math.floor((i / total) * 100)}%`);
				console.log(`DL: ${tag} (${i + 1}/${total})`);

				const chapter = await fetch_chapter(slug, curr.volume, curr.number);

				if (!chapter) {
					++failed;
					console.warn(`Chapter ${tag} failed, skipping`);
					continue;
				}

				const attachments = chapter?.attachments?.map?.(a => ({
						...a,
						url: a?.url?.startsWith?.("/uploads/") ? `${window.location.origin}${a.url}` : `${window.location.origin}/uploads${a.url}`,
					})) ?? [],
					html = build_chapter_html(chapter, attachments, tag),
					head = `<h1>Том ${curr.volume} Глава ${curr.number}${chapter.name ? " - " + chapter.name : ""}</h1>`;

				// One image at a time; each blob is handed to the zip writer and then
				// released, so peak memory is a single image, not the whole archive.
				for (const attachment of attachments) {
					const blob = await fetch_blob(attachment.url);

					if (!blob) {
						console.warn(`Image failed: ${attachment.url}`);
						continue;
					}

					// Images are already compressed; storing them is faster and the same size.
					await writer.add(`images/${tag}/${attachment.filename}`, new zip.BlobReader(blob), { level: 0 });
				}

				await writer.add(
					`chapters_html/${tag}.html`,
					new zip.TextReader(html_template(
						`${title} · Том ${curr.volume} Глава ${curr.number}` + (chapter.name ? ` · ${chapter.name}` : ""),
						head, html, curr.id
					))
				);

				await writer.add(
					`chapters_txt/${tag}.txt`,
					new zip.TextReader(html_to_text(title, curr, chapter, html))
				);

				if (CONFIG.chapters_per_pause && i > 0 && (i + 1) % CONFIG.chapters_per_pause === 0 && i < total - 1) {
					set_status("⏳");
					await delay(CONFIG.pause_ms);
				}
			}

			set_status("💾");
			await writer.close();

			if (sink.kind === "disk") {
				await sink.writable.close();
			} else {
				const blob = await sink.blob_writer.getData(),
					url = URL.createObjectURL(blob),
					a = create_element("a", { href: url, download: `${slug}.zip` });

				a.click();
				setTimeout(() => URL.revokeObjectURL(url), 60_000);
			}

			set_status("📥");
			console.log(`Done: ${total - failed}/${total} chapters${failed ? `, ${failed} failed` : ""}`);
			if (failed) alert(`Готово, но ${failed} глав(ы) не скачались — подробности в консоли.`);
		} catch (e) {
			console.error("Archiving failed\n", e);
			set_status("❌");
			try { await sink.writable?.abort?.(); } catch {}
			alert(`Ошибка при архивации: ${e?.message ?? e}`);
			setTimeout(() => set_status("📥"), 5_000);
		}
	};

	// -------------------------------------------------------------------- ui

	const btn = create_element("div", {
		style: "width: 40px; height: 40px; cursor: pointer; position: fixed; right: 20px; bottom: 20px; background: #dbdbdb30; border: 1px solid #dbdbdb; border-radius: 14px; user-select: none; line-height: 38px; font-size: 15px; text-align: center; z-index: 10; color: #dbdbdb;",
		innerText: "📥",
		title: "Скачать архив",
	});

	document.body.appendChild(btn);

	let busy = false;

	btn.addEventListener("click", async () => {
		if (busy) return;
		busy = true;

		await probe_web_workers();
		await dl_archive(btn);

		busy = false;
	});
})();
