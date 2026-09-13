// ==UserScript==
// @name         Archive ranobe EPUB
// @namespace    https://github.com/QRANG/ranobelib-epub-userscript
// @version      2026.09.13
// @description  Download ranobe from ranobelib.me as a single EPUB 3 file with nested volume/chapter navigation and embedded images. Streams to disk, constant memory usage.
// @author       X4, QRANG
// @license      MIT
// @homepageURL  https://github.com/QRANG/ranobelib-epub-userscript
// @supportURL   https://github.com/QRANG/ranobelib-epub-userscript/issues
// @downloadURL  https://raw.githubusercontent.com/QRANG/ranobelib-epub-userscript/main/ranobelib-epub.user.js
// @updateURL    https://raw.githubusercontent.com/QRANG/ranobelib-epub-userscript/main/ranobelib-epub.user.js
// @match        https://ranobelib.me/*book/*
// @icon         https://icons.duckduckgo.com/ip2/ranobelib.me.ico
// @require      https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.7.57/dist/zip.min.js
// @grant        none
// ==/UserScript==

(() => {
	"use strict";

	// ------------------------------------------------------------------ config

	const CONFIG = {
		compression_level: 9,		// 0..9 for text; images are always stored (level 0)
		chapters_per_pause: 100,	// ratelimit pacing: pause after this many chapters
		pause_ms: 60_000,
		image_retries: 2,
		language: "ru",
		// ranobelib stores chapter JSON in tiptap format. Proper tiptap semantics
		// concatenate the inline nodes of a paragraph and only break on hardBreak.
		// If your output comes out with lines glued together, flip this to true to
		// restore the old behaviour (one <br/> between every inline node).
		legacy_line_breaks: false,
	};

	// ----------------------------------------------------------------- helpers

	const create_element = (tag, attrs) => attrs ? Object.assign(document.createElement(tag), attrs) : document.createElement(tag);

	const delay = time => new Promise(resolve => setTimeout(resolve, time));

	const unix_timestamp = () => Math.floor(new Date().getTime() / 1_000);

	// XML 1.0 forbids most C0 control characters outright — strip before escaping.
	const clean_xml = s => String(s ?? "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/g, "");

	const esc = s => clean_xml(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");

	const safe_name = s => String(s ?? "").replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "_") || "_";

	const pad_number = n => {
		const v = Number.isFinite(+n) && `${n}`.trim() !== "" ? +n : null;
		return v === null ? safe_name(n) : v.toLocaleString("en-US", { minimumIntegerDigits: 3, useGrouping: false });
	};

	const chapter_tag = ch => `v${safe_name(ch.volume)}_${pad_number(ch.number)}`;

	// "84179--sabikui-bisconovel" -> "Sabikui bisco". ranobelib prefixes slugs with the
	// title id and glues "novel" onto the last word to tell ranobe apart from manga.
	// Falls back to the raw slug if nothing readable is left after cleanup.
	const file_title = (slug) => {
		const name = String(slug ?? "")
			.replace(/^\d+-+/, "")
			.replace(/novel$/i, "")
			.replace(/[-_]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();

		return /[a-z0-9]/i.test(name) ? name[0].toUpperCase() + name.slice(1) : slug;
	};

	const basename = url => {
		try {
			return decodeURIComponent(new URL(url, window.location.origin).pathname.split("/").pop() || "");
		} catch {
			return String(url).split(/[?#]/)[0].split("/").pop() || "";
		}
	};

	const MEDIA_TYPES = {
		jpg: "image/jpeg", jpeg: "image/jpeg", jpe: "image/jpeg",
		png: "image/png", gif: "image/gif", webp: "image/webp",
		avif: "image/avif", svg: "image/svg+xml", bmp: "image/bmp",
	};

	const media_type_of = (filename, blob) => {
		const ext = filename.split(".").pop()?.toLowerCase();
		if (MEDIA_TYPES[ext]) return MEDIA_TYPES[ext];
		if (blob?.type?.startsWith("image/")) return blob.type;
		return "image/jpeg";
	};

	// ------------------------------------------------------------------ network

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
					const reset_at = resp.headers.has("X-Ratelimit-Reset") ? +resp.headers.get("X-Ratelimit-Reset") : unix_timestamp() + 60;

					await delay(Math.max(1, reset_at - unix_timestamp()) * 1_000);
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

	const fetch_ranobe_data = async (slug) => (await fetch_json(`https://api.cdnlibs.org/api/manga/${slug}?fields[]=background&fields[]=eng_name&fields[]=otherNames&fields[]=summary&fields[]=releaseDate&fields[]=type_id&fields[]=genres&fields[]=tags&fields[]=teams&fields[]=authors&fields[]=publisher&fields[]=artists&fields[]=chap_count&fields[]=status_id`))?.data;

	// ------------------------------------------------------------- epub assets

	const STYLE_CSS = `@namespace "http://www.w3.org/1999/xhtml";

body {
	margin: 0 5%;
	padding: 0;
	text-align: justify;
	line-height: 1.4;
	widows: 2;
	orphans: 2;
}

h1, h2, h3 {
	text-align: center;
	line-height: 1.3;
	page-break-after: avoid;
	break-after: avoid;
	margin: 1em 0 0.8em 0;
}

h1.volume {
	margin-top: 30%;
	font-size: 1.8em;
}

h1.chapter {
	font-size: 1.3em;
}

p.subtitle {
	text-align: center;
	font-style: italic;
	margin: 0 0 1.5em 0;
}

p {
	margin: 0 0 0.35em 0;
	text-indent: 1.2em;
}

p.noindent, blockquote p {
	text-indent: 0;
}

blockquote {
	margin: 1em 2em;
	font-style: italic;
}

hr {
	border: 0;
	border-top: 1px solid currentColor;
	margin: 1.5em 20%;
	opacity: 0.4;
}

div.image {
	text-align: center;
	text-indent: 0;
	margin: 1em 0;
	page-break-inside: avoid;
	break-inside: avoid;
}

div.image img {
	max-width: 100%;
	max-height: 100%;
}

div.cover {
	text-align: center;
	text-indent: 0;
	margin: 0;
	padding: 0;
}

div.cover img {
	max-width: 100%;
	max-height: 100%;
}

dl.meta {
	font-size: 0.9em;
}

dl.meta dt {
	font-weight: bold;
	margin-top: 0.6em;
}

dl.meta dd {
	margin: 0 0 0 1.5em;
}`;

	// `css` differs by depth: files in OEBPS/text/ need to climb one level up.
	const xhtml_doc = (title, body, css = "../style.css") => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${esc(CONFIG.language)}" lang="${esc(CONFIG.language)}">
<head>
	<meta charset="UTF-8" />
	<title>${esc(title)}</title>
	<link rel="stylesheet" type="text/css" href="${esc(css)}" />
</head>
<body>
${body}
</body>
</html>`;

	const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
	<rootfiles>
		<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" />
	</rootfiles>
</container>`;

	// --------------------------------------------------------- content builders

	const strip_html = (s) => {
		if (!s) return "";
		const doc = new DOMParser().parseFromString(String(s), "text/html");
		return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
	};

	const names_of = (list) => (Array.isArray(list) ? list : []).map(a => a?.rus_name || a?.name).filter(Boolean);

	// Serialize a DOM subtree into well-formed XHTML. Going through the HTML parser
	// first is what makes the result valid: it repairs unclosed tags, stray "&",
	// mis-nesting and everything else the API markup throws at us.
	const serialize_children = (node) => {
		const ser = new XMLSerializer();
		let out = "";

		for (const child of node.childNodes) {
			out += ser.serializeToString(child);
		}

		// The parser puts everything in the XHTML namespace already declared on <html>,
		// so the per-element xmlns the serializer adds is redundant noise.
		return clean_xml(out.replace(/ xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"/g, ""));
	};

	const FORBIDDEN_TAGS = ["script", "style", "link", "iframe", "object", "embed", "form", "input", "button", "noscript", "base", "meta"];

	const sanitize_dom = (root, tag, images) => {
		for (const sel of FORBIDDEN_TAGS) {
			for (const el of [...root.querySelectorAll(sel)]) el.remove();
		}

		for (const el of [...root.querySelectorAll("*")]) {
			for (const attr of [...el.attributes]) {
				const name = attr.name.toLowerCase();

				if (name.startsWith("on") || name === "srcset" || name === "loading" || name === "data-src") el.removeAttribute(attr.name);
				else if ((name === "href" || name === "src") && /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
			}

			// External links would dangle in an offline book; keep the text, drop the link.
			if (el.tagName === "A" && /^https?:/i.test(el.getAttribute("href") ?? "")) el.removeAttribute("href");
		}

		// Point every <img> at a file we actually put in the archive, drop the rest —
		// a manifest reference to a missing file breaks the whole book in most readers.
		for (const img of [...root.querySelectorAll("img")]) {
			const file = images.get(basename(img.getAttribute("src") ?? ""));

			if (!file) {
				img.remove();
				continue;
			}

			for (const attr of [...img.attributes]) {
				if (!["alt", "src"].includes(attr.name.toLowerCase())) img.removeAttribute(attr.name);
			}

			img.setAttribute("src", `../images/${tag}/${file}`);
			if (!img.hasAttribute("alt")) img.setAttribute("alt", "");

			// <img> is inline; wrapping it keeps readers from indenting it like text.
			if (img.parentElement?.tagName !== "DIV" || !img.parentElement.classList.contains("image")) {
				const box = img.ownerDocument.createElement("div");

				box.className = "image";
				img.replaceWith(box);
				box.appendChild(img);
			}
		}

		return root;
	};

	const inline_to_dom = (doc, parent, items) => {
		for (const item of items ?? []) {
			if (item?.type === "hardBreak") {
				parent.appendChild(doc.createElement("br"));
				continue;
			}

			let node = doc.createTextNode(item?.text ?? "");

			for (const mark of item?.marks ?? []) {
				const wrap = doc.createElement(
					mark?.type === "bold" || mark?.type === "strong" ? "strong"
						: mark?.type === "italic" || mark?.type === "em" ? "em"
							: mark?.type === "underline" ? "u"
								: mark?.type === "strike" ? "s" : "span"
				);

				wrap.appendChild(node);
				node = wrap;
			}

			parent.appendChild(node);

			if (CONFIG.legacy_line_breaks && item !== (items ?? []).at(-1)) parent.appendChild(doc.createElement("br"));
		}
	};

	// Builds the chapter body as XHTML. `images` maps original image filename -> stored filename.
	const build_chapter_body = (chapter, tag, images) => {
		const doc = document.implementation.createHTMLDocument("");

		if (typeof chapter.content === "string") {
			doc.body.innerHTML = chapter.content;
		} else {
			for (const node of chapter.content?.content ?? []) {
				if (node?.type === "image") {
					const img = doc.createElement("img");

					img.setAttribute("src", node?.attrs?.images?.[0]?.image ?? "");
					img.setAttribute("alt", "");
					doc.body.appendChild(img);
					continue;
				}

				if (node?.type === "horizontalRule") {
					doc.body.appendChild(doc.createElement("hr"));
					continue;
				}

				const p = doc.createElement("p");

				if (node?.type === "paragraph") inline_to_dom(doc, p, node?.content);
				else p.textContent = node?.text ?? "";

				doc.body.appendChild(p);
			}
		}

		sanitize_dom(doc.body, tag, images);

		return serialize_children(doc.body) || "<p> </p>";
	};

	// ------------------------------------------------------- package documents

	const build_opf = (meta, manifest, spine) => {
		const dc = [
			`<dc:identifier id="pub-id">${esc(meta.identifier)}</dc:identifier>`,
			`<dc:title>${esc(meta.title)}</dc:title>`,
			`<dc:language>${esc(CONFIG.language)}</dc:language>`,
			...meta.authors.map(a => `<dc:creator>${esc(a)}</dc:creator>`),
			...meta.artists.map(a => `<dc:contributor>${esc(a)}</dc:contributor>`),
			...(meta.publisher ? [`<dc:publisher>${esc(meta.publisher)}</dc:publisher>`] : []),
			...(meta.description ? [`<dc:description>${esc(meta.description)}</dc:description>`] : []),
			...(meta.date ? [`<dc:date>${esc(meta.date)}</dc:date>`] : []),
			...meta.subjects.map(s => `<dc:subject>${esc(s)}</dc:subject>`),
			`<dc:source>${esc(meta.source)}</dc:source>`,
		];

		return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="${esc(CONFIG.language)}">
	<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
${dc.map(l => `\t\t${l}`).join("\n")}
		<meta property="dcterms:modified">${esc(meta.modified)}</meta>
${meta.cover_id ? `\t\t<meta name="cover" content="${esc(meta.cover_id)}" />\n` : ""}	</metadata>
	<manifest>
${manifest.map(i => `\t\t<item id="${esc(i.id)}" href="${esc(i.href)}" media-type="${esc(i.type)}"${i.properties ? ` properties="${esc(i.properties)}"` : ""} />`).join("\n")}
	</manifest>
	<spine toc="ncx" page-progression-direction="ltr">
${spine.map(s => `\t\t<itemref idref="${esc(s.id)}"${s.linear === false ? ` linear="no"` : ""} />`).join("\n")}
	</spine>
	<guide>
${meta.cover_page ? `\t\t<reference type="cover" title="Обложка" href="${esc(meta.cover_page)}" />\n` : ""}\t\t<reference type="toc" title="Оглавление" href="nav.xhtml" />
		<reference type="text" title="Начало" href="${esc(meta.start_page)}" />
	</guide>
</package>`;
	};

	// EPUB 2 navigation. Still the only TOC many e-ink readers and older apps read.
	const build_ncx = (meta, toc) => {
		let order = 0;

		const point = (entry, depth) => {
			const id = `np${++order}`,
				children = (entry.children ?? []).map(c => point(c, depth + 1)).join("");
			const pad = "\t".repeat(depth + 2);

			return `${pad}<navPoint id="${id}" playOrder="${order}">
${pad}\t<navLabel><text>${esc(entry.label)}</text></navLabel>
${pad}\t<content src="${esc(entry.href)}" />
${children}${pad}</navPoint>
`;
		};

		return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="${esc(CONFIG.language)}">
	<head>
		<meta name="dtb:uid" content="${esc(meta.identifier)}" />
		<meta name="dtb:depth" content="2" />
		<meta name="dtb:totalPageCount" content="0" />
		<meta name="dtb:maxPageNumber" content="0" />
	</head>
	<docTitle><text>${esc(meta.title)}</text></docTitle>
	<navMap>
${toc.map(e => point(e, 0)).join("")}	</navMap>
</ncx>`;
	};

	// EPUB 3 navigation document. Nested <ol> is what gives volume -> chapter drilldown.
	const build_nav = (meta, toc) => {
		const list = (entries, depth) => {
			const pad = "\t".repeat(depth + 2);

			return `${pad}<ol>
${entries.map(e => `${pad}\t<li>
${pad}\t\t<a href="${esc(e.href)}">${esc(e.label)}</a>
${e.children?.length ? list(e.children, depth + 2) : ""}${pad}\t</li>
`).join("")}${pad}</ol>
`;
		};

		return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${esc(CONFIG.language)}" lang="${esc(CONFIG.language)}">
<head>
	<meta charset="UTF-8" />
	<title>Оглавление</title>
	<link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
	<nav epub:type="toc" id="toc">
		<h1>Оглавление</h1>
${list(toc, 0)}	</nav>
	<nav epub:type="landmarks" hidden="hidden">
		<h2>Ориентиры</h2>
		<ol>
${meta.cover_page ? `\t\t\t<li><a epub:type="cover" href="${esc(meta.cover_page)}">Обложка</a></li>\n` : ""}			<li><a epub:type="toc" href="nav.xhtml">Оглавление</a></li>
			<li><a epub:type="bodymatter" href="${esc(meta.start_page)}">Начало</a></li>
		</ol>
	</nav>
</body>
</html>`;
	};

	// --------------------------------------------------------------- zip sinks

	const pick_file_sink = async (suggested_name) => {
		if (!window.showSaveFilePicker) return;

		try {
			const handle = await window.showSaveFilePicker({
				suggestedName: suggested_name,
				types: [{ description: "EPUB book", accept: { "application/epub+zip": [".epub"] } }],
			});

			return { writable: await handle.createWritable(), kind: "disk" };
		} catch (e) {
			if (e?.name === "AbortError") return null;
			console.warn("showSaveFilePicker failed, falling back to in-memory blob\n", e);
		}
	};

	const probe_web_workers = async () => {
		try {
			zip.configure({ useWebWorkers: true });
			const w = new zip.ZipWriter(new zip.BlobWriter("application/zip"), { level: 1 });
			await w.add("probe.txt", new zip.TextReader("probe"));
			await w.close();
		} catch (e) {
			console.warn("Web workers unavailable (CSP?), compressing on the main thread\n", e);
			zip.configure({ useWebWorkers: false });
		}
	};

	// --------------------------------------------------------------- main flow

	const dl_epub = async (btn) => {
		const slug = window.location.pathname.match(/(?<=book\/)[\w\-]+/)?.[0];
		if (!slug) return alert("Не удалось определить slug тайтла.");

		// Must be the first await: showSaveFilePicker needs transient user activation.
		const picked = await pick_file_sink(`${file_title(slug)}.epub`);
		if (picked === null) return;

		const sink = picked ?? { blob_writer: new zip.BlobWriter("application/epub+zip"), kind: "blob" },
			set_status = text => { btn.innerText = text; btn.title = text; };

		set_status("…");

		const ranobe_data = await fetch_ranobe_data(slug),
			title = ranobe_data?.rus_name || ranobe_data?.name || slug,
			chapters = await fetch_chapters(slug);

		if (!chapters?.length) {
			set_status("📖");
			return alert("Не удалось получить список глав.");
		}

		const writer = new zip.ZipWriter(sink.writable ?? sink.blob_writer, {
			level: CONFIG.compression_level,
			zip64: true,
			bufferedWrite: false,
		});

		// These grow by ~120 bytes per file, not per byte of content — a 5000-chapter
		// book costs well under a megabyte here while the content itself never
		// accumulates: each entry is streamed out to disk as soon as it is added.
		const manifest = [],
			spine = [],
			toc = [];

		let failed = 0,
			image_seq = 0,
			cover_id = null,
			cover_page = null;

		const add_text = (href, content, opts) => writer.add(`OEBPS/${href}`, new zip.TextReader(content), opts);

		try {
			// The EPUB OCF spec requires this exact first entry: uncompressed, no extra
			// fields, no data descriptor — some readers sniff it at a fixed byte offset.
			await writer.add("mimetype", new zip.TextReader("application/epub+zip"), {
				level: 0, zip64: false, dataDescriptor: false, extendedTimestamp: false,
			});
			await writer.add("META-INF/container.xml", new zip.TextReader(CONTAINER_XML));

			await add_text("style.css", STYLE_CSS);
			manifest.push({ id: "css", href: "style.css", type: "text/css" });

			// ---------------------------------------------------------- cover image
			const cover_url = ranobe_data?.cover?.default || ranobe_data?.cover?.md || ranobe_data?.cover?.thumbnail;

			if (cover_url) {
				set_status("🖼");
				const blob = await fetch_blob(cover_url);

				if (blob) {
					const type = media_type_of(basename(cover_url), blob),
						ext = type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";

					await writer.add(`OEBPS/images/cover.${ext}`, new zip.BlobReader(blob), { level: 0 });
					cover_id = "cover-image";
					manifest.push({ id: cover_id, href: `images/cover.${ext}`, type, properties: "cover-image" });

					await add_text("cover.xhtml", xhtml_doc(
						"Обложка",
						`\t<div class="cover" epub:type="cover"><img src="images/cover.${ext}" alt="${esc(title)}" /></div>`,
						"style.css"
					));

					cover_page = "cover.xhtml";
					manifest.push({ id: "cover-page", href: "cover.xhtml", type: "application/xhtml+xml" });
					spine.push({ id: "cover-page" });
					toc.push({ label: "Обложка", href: "cover.xhtml" });
				}
			}

			// ----------------------------------------------------------- title page
			const authors = names_of(ranobe_data?.authors),
				artists = names_of(ranobe_data?.artists),
				publisher = names_of(ranobe_data?.publisher)[0] ?? "",
				teams = names_of(ranobe_data?.teams),
				genres = [...names_of(ranobe_data?.genres), ...names_of(ranobe_data?.tags)],
				summary = strip_html(ranobe_data?.summary),
				other_names = [ranobe_data?.name, ranobe_data?.eng_name, ...(ranobe_data?.otherNames ?? [])]
					.filter(n => n && n !== title);

			const meta_rows = [
				["Автор", authors.join(", ")],
				["Иллюстратор", artists.join(", ")],
				["Издательство", publisher],
				["Перевод", teams.join(", ")],
				["Жанры", genres.join(", ")],
				["Другие названия", other_names.join(" · ")],
				["Год", ranobe_data?.releaseDate ?? ""],
				["Глав в архиве", String(chapters.length)],
			].filter(([, v]) => v);

			await add_text("title.xhtml", xhtml_doc(title, `	<h1 class="chapter">${esc(title)}</h1>
${authors.length ? `\t<p class="subtitle">${esc(authors.join(", "))}</p>\n` : ""}${summary ? `\t<p class="noindent">${esc(summary)}</p>\n` : ""}	<hr />
	<dl class="meta">
${meta_rows.map(([k, v]) => `\t\t<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("\n")}
	</dl>
	<p class="noindent"><small>${esc(`Источник: ${window.location.origin}/ru/book/${slug}`)}</small></p>`, "style.css"));

			manifest.push({ id: "title-page", href: "title.xhtml", type: "application/xhtml+xml" });
			spine.push({ id: "title-page" });
			toc.push({ label: "Описание", href: "title.xhtml" });

			// --------------------------------------------------------- chapter loop
			const total = chapters.length;

			let current_volume = null,
				volume_entry = null,
				start_page = null;

			for (let i = 0; i < total; ++i) {
				const curr = chapters[i],
					tag = chapter_tag(curr);

				set_status(`${Math.floor((i / total) * 100)}%`);
				console.log(`DL: том ${curr.volume} глава ${curr.number} (${i + 1}/${total})`);

				const chapter = await fetch_chapter(slug, curr.volume, curr.number);

				if (!chapter) {
					++failed;
					console.warn(`Chapter ${tag} failed, skipping`);
					continue;
				}

				// Images first: the chapter body may only reference files that made it in.
				const attachments = chapter?.attachments?.map?.(a => ({
						...a,
						url: a?.url?.startsWith?.("/uploads/") ? `${window.location.origin}${a.url}` : `${window.location.origin}/uploads${a.url}`,
					})) ?? [],
					images = new Map();

				for (const attachment of attachments) {
					const blob = await fetch_blob(attachment.url);

					if (!blob) {
						console.warn(`Image failed: ${attachment.url}`);
						continue;
					}

					const filename = safe_name(attachment.filename || basename(attachment.url) || `img${++image_seq}.jpg`),
						href = `images/${tag}/${filename}`;

					await writer.add(`OEBPS/${href}`, new zip.BlobReader(blob), { level: 0 });
					manifest.push({ id: `img${++image_seq}`, href, type: media_type_of(filename, blob) });

					// The JSON format references attachments by `name`, the HTML format by
					// the file name in the URL — index both so either one resolves.
					images.set(filename, filename);
					if (attachment.filename) images.set(attachment.filename, filename);
					if (attachment.name) images.set(attachment.name, filename);
					images.set(basename(attachment.url), filename);
				}

				// Open a new volume section as soon as a chapter of it actually survives.
				if (`${curr.volume}` !== current_volume) {
					current_volume = `${curr.volume}`;

					const vol_href = `text/vol_${safe_name(curr.volume)}.xhtml`,
						vol_id = `vol-${safe_name(curr.volume)}`,
						vol_label = `Том ${curr.volume}`;

					await add_text(vol_href, xhtml_doc(vol_label, `\t<h1 class="volume" id="top">${esc(vol_label)}</h1>`));

					manifest.push({ id: vol_id, href: vol_href, type: "application/xhtml+xml" });
					spine.push({ id: vol_id });

					volume_entry = { label: vol_label, href: vol_href, children: [] };
					toc.push(volume_entry);
				}

				const href = `text/${tag}.xhtml`,
					id = `ch-${tag}`,
					label = `Глава ${curr.number}${chapter.name ? ` — ${chapter.name}` : ""}`,
					head = `	<h1 class="chapter" id="top">${esc(`Глава ${curr.number}`)}</h1>
${chapter.name ? `\t<p class="subtitle">${esc(chapter.name)}</p>\n` : ""}`;

				await add_text(href, xhtml_doc(
					`${title} · Том ${curr.volume} Глава ${curr.number}`,
					head + build_chapter_body(chapter, tag, images)
				));

				manifest.push({ id, href, type: "application/xhtml+xml" });
				spine.push({ id });
				volume_entry.children.push({ label, href });

				start_page ??= href;

				if (CONFIG.chapters_per_pause && i > 0 && (i + 1) % CONFIG.chapters_per_pause === 0 && i < total - 1) {
					set_status("⏳");
					await delay(CONFIG.pause_ms);
				}
			}

			if (!start_page) throw new Error("Ни одна глава не скачалась");

			// ------------------------------------------------- package documents
			// Written last on purpose: the manifest can only be complete once every
			// image is known, and ZIP does not care about entry order past `mimetype`.
			set_status("💾");

			const meta = {
				identifier: `urn:uuid:${crypto.randomUUID?.() ?? `ranobelib-${slug}-${Date.now()}`}`,
				title, authors, artists, publisher,
				description: summary,
				subjects: genres,
				date: ranobe_data?.releaseDate ? `${ranobe_data.releaseDate}` : "",
				modified: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
				source: `${window.location.origin}/ru/book/${slug}`,
				cover_id, cover_page, start_page,
			};

			manifest.push({ id: "nav", href: "nav.xhtml", type: "application/xhtml+xml", properties: "nav" });
			manifest.push({ id: "ncx", href: "toc.ncx", type: "application/x-dtbncx+xml" });
			spine.push({ id: "nav", linear: false });

			await add_text("nav.xhtml", build_nav(meta, toc));
			await add_text("toc.ncx", build_ncx(meta, toc));
			await add_text("content.opf", build_opf(meta, manifest, spine));

			await writer.close();

			if (sink.kind === "disk") {
				await sink.writable.close();
			} else {
				const blob = await sink.blob_writer.getData(),
					url = URL.createObjectURL(blob),
					a = create_element("a", { href: url, download: `${file_title(slug)}.epub` });

				a.click();
				setTimeout(() => URL.revokeObjectURL(url), 60_000);
			}

			set_status("📖");
			console.log(`Done: ${total - failed}/${total} chapters${failed ? `, ${failed} failed` : ""}`);
			if (failed) alert(`Готово, но ${failed} глав(ы) не скачались — подробности в консоли.`);
		} catch (e) {
			console.error("EPUB build failed\n", e);
			set_status("❌");
			try { await sink.writable?.abort?.(); } catch {}
			alert(`Ошибка при сборке EPUB: ${e?.message ?? e}`);
			setTimeout(() => set_status("📖"), 5_000);
		}
	};

	// -------------------------------------------------------------------- ui

	const btn = create_element("div", {
		style: "width: 40px; height: 40px; cursor: pointer; position: fixed; right: 20px; bottom: 70px; background: #dbdbdb30; border: 1px solid #dbdbdb; border-radius: 14px; user-select: none; line-height: 38px; font-size: 15px; text-align: center; z-index: 10; color: #dbdbdb;",
		innerText: "📖",
		title: "Скачать EPUB",
	});

	document.body.appendChild(btn);

	let busy = false;

	btn.addEventListener("click", async () => {
		if (busy) return;
		busy = true;

		await probe_web_workers();
		await dl_epub(btn);

		busy = false;
	});
})();
