import * as fontkit from 'fontkit';
import { mkdirSync, writeFileSync } from 'node:fs';
import { asciiFrames, createFluid, smoothstep, type AsciiOptions } from './ascii';

const root = new URL('..', import.meta.url).pathname;
const outDir = `${root}assets/`;

type Glyph = { id: number; path: { commands: { command: string; args: number[] }[] } };
type Font = {
	unitsPerEm: number;
	layout: (text: string) => {
		glyphs: Glyph[];
		positions: { xAdvance: number; xOffset: number; yOffset: number }[];
	};
};

const loadFont = (pkg: string, file: string) =>
	fontkit.openSync(`${root}node_modules/@fontsource/${pkg}/files/${file}.woff2`) as unknown as Font;

const fonts = {
	sans: loadFont('geist-sans', 'geist-sans-latin-400-normal'),
	medium: loadFont('geist-sans', 'geist-sans-latin-500-normal'),
	serif: loadFont('instrument-serif', 'instrument-serif-latin-400-italic')
};

type FontKey = keyof typeof fonts;

const GLYPH_PREFIX: Record<FontKey, string> = { sans: 'a', medium: 'b', serif: 'c' };

const round = (value: number, digits = 2) => String(+value.toFixed(digits));

function oklch(lightness: number, chroma: number, hue: number) {
	const a = chroma * Math.cos((hue * Math.PI) / 180);
	const b = chroma * Math.sin((hue * Math.PI) / 180);
	const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
	const linear = [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
	];
	const channel = (value: number) => {
		const clamped = Math.min(1, Math.max(0, value));
		const encoded = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
		return Math.round(encoded * 255)
			.toString(16)
			.padStart(2, '0');
	};
	return `#${linear.map(channel).join('')}`;
}

const color = {
	foreground: oklch(0.141, 0.005, 285.823),
	ink: oklch(0.27, 0.055, 255),
	shineDeep: oklch(0.4, 0.12, 260),
	shineMid: oklch(0.58, 0.12, 252),
	shineLight: oklch(0.78, 0.07, 240),
	white: '#ffffff'
};

const palette = {
	base: '#bcd4fb',
	deep: '#1f5cf0',
	indigo: '#4f63f3',
	azure: '#3d86ff',
	sky: '#6cabff',
	pale: '#e4edff',
	mist: '#f4f7ff',
	lavender: '#cfcdf3',
	periwinkle: '#93a4ff',
	peach: '#ffd9c7'
};

const COMMAND_LETTERS: Record<string, string> = {
	moveTo: 'M',
	lineTo: 'L',
	quadraticCurveTo: 'Q',
	bezierCurveTo: 'C',
	closePath: 'Z'
};

const glyphPath = (glyph: Glyph, offsetX = 0, offsetY = 0) =>
	glyph.path.commands
		.map(
			({ command, args }) =>
				COMMAND_LETTERS[command] +
				args.map((value, i) => round(value + (i % 2 === 0 ? offsetX : offsetY), 0)).join(' ')
		)
		.join('');

function outline(fontKey: FontKey, text: string) {
	const font = fonts[fontKey];
	const run = font.layout(text);
	let cursor = 0;
	let d = '';
	run.glyphs.forEach((glyph, index) => {
		const position = run.positions[index];
		d += glyphPath(glyph, cursor + position.xOffset, position.yOffset);
		cursor += position.xAdvance;
	});
	return { d, width: cursor, unitsPerEm: font.unitsPerEm };
}

type TextOptions = {
	font?: FontKey;
	size: number;
	tracking?: number;
	anchor?: 'start' | 'middle' | 'end';
	fill?: string;
	opacity?: number;
};

class GlyphSheet {
	private defs = new Map<string, string>();

	measure(text: string, { font = 'sans', size, tracking = 0 }: TextOptions) {
		const face = fonts[font];
		const run = face.layout(text);
		const advance = run.positions.reduce((sum, position) => sum + position.xAdvance, 0);
		return (advance * size) / face.unitsPerEm + tracking * Math.max(0, run.glyphs.length - 1);
	}

	wrap(text: string, maxWidth: number, options: TextOptions) {
		const lines: string[] = [];
		let line = '';
		for (const word of text.split(' ')) {
			const candidate = line ? `${line} ${word}` : word;
			if (line && this.measure(candidate, options) > maxWidth) {
				lines.push(line);
				line = word;
			} else {
				line = candidate;
			}
		}
		return line ? [...lines, line] : lines;
	}

	text(text: string, x: number, y: number, options: TextOptions) {
		const { font = 'sans', size, tracking = 0, anchor = 'start', fill = color.ink, opacity } = options;
		const face = fonts[font];
		const scale = size / face.unitsPerEm;
		const width = this.measure(text, options);
		const originX = x - (anchor === 'end' ? width : anchor === 'middle' ? width / 2 : 0);
		const run = face.layout(text);
		let cursor = 0;
		let uses = '';
		run.glyphs.forEach((glyph, index) => {
			const position = run.positions[index];
			if (glyph.path.commands.length > 0) {
				const id = `${GLYPH_PREFIX[font]}${glyph.id}`;
				if (!this.defs.has(id)) this.defs.set(id, `<path id="${id}" d="${glyphPath(glyph)}"/>`);
				const glyphX = Math.round(cursor + position.xOffset);
				uses += `<use href="#${id}"${glyphX ? ` x="${glyphX}"` : ''}${position.yOffset ? ` y="${position.yOffset}"` : ''}/>`;
			}
			cursor += position.xAdvance + tracking / scale;
		});
		const opacityAttr = opacity === undefined ? '' : ` opacity="${opacity}"`;
		return `<g transform="translate(${round(originX)} ${round(y)}) scale(${round(scale, 5)} ${round(-scale, 5)})" fill="${fill}"${opacityAttr}>${uses}</g>`;
	}

	render() {
		return [...this.defs.values()].join('');
	}
}

// Regular spaces collapse inside SVG <text>, which would let textLength stretch the row.
const NBSP = ' ';
const MONO_STACK =
	"ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono','DejaVu Sans Mono',monospace";

function asciiLayer(options: AsciiOptions & { frameDuration?: number; opacity?: number }) {
	const { cell, frameDuration = 0.125, opacity = 0.92 } = options;
	const frames = asciiFrames(options);
	const used = frames.flatMap((frame) =>
		frame.flatMap((line) => [...line].flatMap((char, col) => (char === ' ' ? [] : [col])))
	);
	if (used.length === 0) return { markup: '', css: '' };
	const firstCol = Math.min(...used);
	const lastCol = Math.max(...used);
	const fontSize = cell * 0.8;
	const glyphAdvance = fontSize * 0.6;
	const startX = firstCol * cell + (cell - glyphAdvance) / 2;
	const textLength = round((lastCol - firstCol) * cell + glyphAdvance, 1);

	const renderFrame = (frame: string[]) =>
		frame
			.map((line, row) => {
				const slice = line.slice(firstCol, lastCol + 1);
				if (slice.trim() === '') return '';
				return `<text y="${round(row * cell + cell * 0.74, 1)}" textLength="${textLength}">${slice.replaceAll(' ', NBSP)}</text>`;
			})
			.join('');

	const animated = frames.length > 1;
	const body = animated
		? frames
				.map(
					(frame, index) =>
						`<g class="f"${index ? ` style="animation-delay:${round(index * frameDuration, 3)}s"` : ''}>${renderFrame(frame)}</g>`
				)
				.join('')
		: renderFrame(frames[0]);
	const css = animated
		? `.f{visibility:hidden;animation:f ${round(frames.length * frameDuration, 3)}s steps(1,end) infinite}` +
			`@keyframes f{0%{visibility:visible}${round(100 / frames.length, 4)}%,100%{visibility:hidden}}` +
			`@media (prefers-reduced-motion:reduce){.f{animation:none}.f:first-child{visibility:visible}}`
		: '';
	const markup = `<g transform="translate(${round(startX, 1)} 0)" font-family="${MONO_STACK}" font-weight="800" font-size="${round(fontSize, 1)}" fill="${color.white}" opacity="${opacity}">${body}</g>`;
	return { markup, css };
}

type Blob = { x: number; y: number; rx: number; ry: number; fill: string };

function backdrop(width: number, height: number, blobs: Blob[]) {
	const fills = [...new Set(blobs.map((blob) => blob.fill))];
	const gradientId = (fill: string) => `g${fills.indexOf(fill)}`;
	const falloff = [
		[0, 1],
		[0.2, 0.9],
		[0.4, 0.66],
		[0.6, 0.36],
		[0.8, 0.12],
		[1, 0]
	];
	const defs = fills
		.map(
			(fill) =>
				`<radialGradient id="${gradientId(fill)}">${falloff
					.map(([offset, alpha]) => `<stop offset="${offset}" stop-color="${fill}" stop-opacity="${alpha}"/>`)
					.join('')}</radialGradient>`
		)
		.join('');
	const markup =
		`<rect width="${width}" height="${height}" fill="${palette.base}"/>` +
		blobs
			.map(
				(blob) =>
					`<ellipse cx="${blob.x}" cy="${blob.y}" rx="${blob.rx}" ry="${blob.ry}" fill="url(#${gradientId(blob.fill)})"/>`
			)
			.join('');
	return { defs, markup };
}

type SvgOptions = {
	width: number;
	height: number;
	card: { x: number; y: number; width: number; height: number };
	radius: number;
	title: string;
	defs: string;
	css?: string;
	body: string;
};

function svg({ width, height, card, radius, title, defs, css, body }: SvgOptions) {
	const inset = 0.75;
	const label = title.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${label}">` +
		`<title>${label}</title>` +
		(css ? `<style>${css}</style>` : '') +
		`<defs><clipPath id="card"><rect width="${card.width}" height="${card.height}" rx="${radius}"/></clipPath>` +
		`<linearGradient id="rim" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".85"/><stop offset=".5" stop-color="#fff" stop-opacity=".18"/><stop offset="1" stop-color="#fff" stop-opacity=".5"/></linearGradient>` +
		`${defs}</defs>` +
		`<g transform="translate(${card.x} ${card.y})">` +
		`<g clip-path="url(#card)">${body}</g>` +
		`<rect x="${inset}" y="${inset}" width="${card.width - inset * 2}" height="${card.height - inset * 2}" rx="${radius - inset}" fill="none" stroke="url(#rim)" stroke-width="1.5"/>` +
		`</g></svg>`
	);
}

const LOGO_PATHS = [
	'M41.216 92.16L0 .64h22.272l33.92 75.52h1.664L91.776.64h22.272L72.832 92.16z',
	'M166.668 92.8q-24.448 0-37.888-11.648-13.44-11.776-13.44-34.816 0-22.912 13.44-34.56Q142.22 0 167.564 0h23.04q25.344 0 38.784 11.776 13.44 11.648 13.44 34.56 0 23.04-13.44 34.816Q215.948 92.8 191.244 92.8zm2.304-76.16q-14.208 0-22.144 5.12t-9.984 16.256h84.48q-2.048-11.136-9.984-16.256t-22.144-5.12zm.384 59.52h19.84q14.336 0 22.144-5.12 7.936-5.12 9.984-16.384h-84.48q2.048 11.264 9.984 16.384t22.512 5.12z',
	'M255.585 92.16V.64h100.352v16.64h-79.872v20.224h72.448v16.64h-72.448V75.52h79.872v16.64z',
	'M93.151 38.16H257v16l-171.278.496z'
];

const logo = (x: number, y: number, height: number, fill: string) =>
	`<g transform="translate(${x} ${y}) scale(${round(height / 93, 4)})" fill="${fill}">${LOGO_PATHS.map((d) => `<path d="${d}"/>`).join('')}</g>`;

const PIN_ICON =
	'<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>';

const RADIUS = 30;
const CELL = 15;
const FLUID_UNIT = 480;

export function banner({ seed = 7, frames = 40 } = {}) {
	const width = 1200;
	const height = 480;
	const pad = 52;
	const sheet = new GlyphSheet();

	const bg = backdrop(width, height, [
		{ x: 1010, y: 70, rx: 560, ry: 400, fill: palette.deep },
		{ x: 1240, y: 260, rx: 330, ry: 300, fill: palette.azure },
		{ x: 300, y: 110, rx: 520, ry: 300, fill: palette.mist },
		{ x: 0, y: -20, rx: 380, ry: 250, fill: palette.peach },
		{ x: 60, y: 520, rx: 480, ry: 250, fill: palette.sky },
		{ x: 640, y: 540, rx: 520, ry: 210, fill: palette.pale },
		{ x: 1160, y: 520, rx: 360, ry: 190, fill: palette.periwinkle }
	]);

	const fluid = createFluid(seed, FLUID_UNIT);
	const ascii = asciiLayer({
		width,
		height,
		cell: CELL,
		frames,
		seed,
		field: (x, y, t) => {
			const reach = smoothstep(400, 820, x + y * 0.3);
			const floor = 1 - smoothstep(130, 290, y - (x - 600) * 0.06);
			const gain = reach * floor;
			return gain <= 0 ? 0 : fluid(x, y, t) * gain;
		}
	});

	const nameSize = 151;
	const baseline = 350;
	const first = outline('sans', 'Victor');
	const last = outline('serif', 'Østergaard.');
	const firstScale = nameSize / first.unitsPerEm;
	const lastScale = nameSize / last.unitsPerEm;
	const lastWidth = last.width * lastScale;
	const lastX = width - pad - lastWidth + 6;
	const nameTransform = (x: number, scale: number) =>
		`transform="translate(${round(x)} ${baseline}) scale(${round(scale, 5)} ${round(-scale, 5)})"`;

	const stops = [
		[0, color.foreground, 1],
		[0.3333, color.foreground, 1],
		[0.4, color.ink, 1],
		[0.45, color.shineDeep, 1],
		[0.5, color.shineMid, 1],
		[0.55, color.shineLight, 1],
		[0.6, color.shineMid, 1],
		[0.6667, color.shineMid, 0],
		[1, color.shineMid, 0]
	] as const;
	// userSpaceOnUse resolves in the surname path's own space, which is font units.
	const sweep = last.width * 2;
	const shine =
		`<linearGradient id="shine" gradientUnits="userSpaceOnUse" x1="0" x2="${last.width * 3}" y1="0" y2="0">` +
		stops
			.map(
				([offset, stopColor, alpha]) =>
					`<stop offset="${offset}" stop-color="${stopColor}"${alpha === 1 ? '' : ` stop-opacity="${alpha}"`}/>`
			)
			.join('') +
		`<animateTransform attributeName="gradientTransform" type="translate" values="-${sweep} 0;-${sweep} 0;0 0" keyTimes="0;.14;1" calcMode="spline" keySplines="0 0 1 1;.35 0 .1 1" dur="2.73s" fill="freeze"/>` +
		`</linearGradient>`;

	const tagline = [
		'building user friendly and performant',
		'full-stack applications with expertise',
		'in agentic AI solutions'
	];
	const dividerY = 404;
	const footerY = 442;
	const footer = { size: 17, font: 'medium' as const, fill: color.foreground };
	const place = 'Copenhagen, Denmark';
	const pinSize = 17;
	const pinX = width - pad - sheet.measure(place, footer) - pinSize - 7;

	const body =
		bg.markup +
		`<g class="fade">${ascii.markup}</g>` +
		`<g class="rise" style="animation-delay:.09s">${logo(pad, 45, 21, color.ink)}</g>` +
		tagline
			.map(
				(line, index) =>
					`<g class="rise" style="animation-delay:${round(0.14 + index * 0.12)}s">${sheet.text(line, pad, 131 + index * 33, { size: 20.5 })}</g>`
			)
			.join('') +
		`<g class="rise" style="animation-delay:.28s"><path ${nameTransform(pad - 3, firstScale)} fill="${color.foreground}" d="${first.d}"/></g>` +
		`<path id="last" ${nameTransform(lastX, lastScale)} fill="url(#shine)" d="${last.d}"/>` +
		`<rect class="draw" x="${pad}" y="${dividerY}" width="${width - pad * 2}" height="1.25" fill="${color.ink}" opacity=".3"/>` +
		`<g class="rise" style="animation-delay:.65s">${sheet.text('→  voe.dk', pad, footerY, footer)}</g>` +
		`<g class="rise" style="animation-delay:.72s">${sheet.text('Senior Software Engineer at Wemuda', width / 2, footerY, { ...footer, anchor: 'middle' })}</g>` +
		`<g class="rise" style="animation-delay:.79s">` +
		`<g transform="translate(${round(pinX)} ${footerY - pinSize + 2.5}) scale(${round(pinSize / 24, 4)})" fill="none" stroke="${color.foreground}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${PIN_ICON}</g>` +
		sheet.text(place, width - pad, footerY, { ...footer, anchor: 'end' }) +
		`</g>`;

	const css =
		ascii.css +
		`.rise{animation:rise .7s cubic-bezier(.22,1,.36,1) both}@keyframes rise{from{opacity:0;transform:translateY(12px)}}` +
		`.fade{animation:fade 1.6s ease-out both}@keyframes fade{from{opacity:0}}` +
		`.draw{transform-origin:${pad}px ${dividerY}px;animation:draw 1.2s cubic-bezier(.22,1,.36,1) both}@keyframes draw{from{transform:scaleX(0)}}` +
		`@media (prefers-reduced-motion:reduce){.rise,.fade,.draw{animation:none}#last{fill:${color.foreground}}}`;

	return svg({
		width,
		height,
		card: { x: 0, y: 0, width, height },
		radius: RADIUS,
		title:
			'Victor Østergaard — building user friendly and performant full-stack applications with expertise in agentic AI solutions',
		defs: bg.defs + shine + sheet.render(),
		css,
		body
	});
}

type Project = {
	file: string;
	title: string;
	kind: string;
	description: string;
	tags: string[];
	seed: number;
	blobs: Blob[];
};

const projects: Project[] = [
	{
		file: 'billigtfrem',
		title: 'BilligtFrem',
		kind: 'Product',
		description: 'Journey planner comparing train, coach, ferry and flight prices across Denmark.',
		tags: ['SvelteKit', 'MapLibre GL', 'Docker'],
		seed: 26,
		blobs: [
			{ x: 560, y: 40, rx: 330, ry: 270, fill: palette.deep },
			{ x: 640, y: 300, rx: 260, ry: 200, fill: palette.azure },
			{ x: 150, y: 100, rx: 330, ry: 210, fill: palette.mist },
			{ x: 40, y: 330, rx: 300, ry: 170, fill: palette.sky }
		]
	},
	{
		file: 'enhanced-video',
		title: 'enhanced-video-sveltekit',
		kind: 'Open source',
		description: 'Build-time video optimization for Svelte and SvelteKit.',
		tags: ['SvelteKit', 'Vite', 'FFmpeg'],
		seed: 5,
		blobs: [
			{ x: 590, y: 250, rx: 330, ry: 270, fill: palette.indigo },
			{ x: 560, y: -10, rx: 260, ry: 170, fill: palette.azure },
			{ x: 170, y: 120, rx: 330, ry: 220, fill: palette.mist },
			{ x: 0, y: -20, rx: 260, ry: 170, fill: palette.peach },
			{ x: 120, y: 330, rx: 300, ry: 150, fill: palette.pale }
		]
	},
	{
		file: 'guideshot',
		title: 'GuideShot',
		kind: 'Open source',
		description: 'Open-source CLI for annotated product screenshots.',
		tags: ['TypeScript', 'Playwright', 'CLI'],
		seed: 3,
		blobs: [
			{ x: 600, y: 120, rx: 320, ry: 300, fill: palette.azure },
			{ x: 520, y: 330, rx: 300, ry: 170, fill: palette.deep },
			{ x: 160, y: 90, rx: 330, ry: 210, fill: palette.mist },
			{ x: 0, y: 320, rx: 280, ry: 170, fill: palette.peach }
		]
	},
	{
		file: 'auro',
		title: 'Auro Pictures',
		kind: 'Product',
		description: 'Client gallery platform for photographers.',
		tags: ['SvelteKit', 'Cloudflare Workers', 'AI'],
		seed: 22,
		blobs: [
			{ x: 620, y: 60, rx: 300, ry: 260, fill: palette.indigo },
			{ x: 560, y: 300, rx: 300, ry: 190, fill: palette.deep },
			{ x: 150, y: 110, rx: 330, ry: 220, fill: palette.mist },
			{ x: 60, y: 330, rx: 300, ry: 160, fill: palette.lavender }
		]
	}
];

const TILE = { width: 600, height: 290, pad: 32, gapX: 12, gapY: 14 };

function tile(project: Project, index: number, titleSize: number) {
	const { width, height, pad } = TILE;
	const sheet = new GlyphSheet();
	const bg = backdrop(width, height, project.blobs);
	const label = { size: 14.5, font: 'medium' as const, tracking: 1.5 };
	const copy = { size: 19.5 };
	const title = { size: titleSize, font: 'serif' as const, fill: color.foreground };
	const tags = { size: 15, font: 'medium' as const, opacity: 0.78 };
	const tagLine = project.tags.join('  ·  ');
	const lines = sheet.wrap(project.description, 400, copy);
	const arrow = { x: width - pad - 20, y: pad + 20, radius: 20 };

	const textBoxes = [
		{ right: pad + 200, top: 40, bottom: 58 },
		{ right: pad + sheet.measure(project.title, title), top: 152 - titleSize * 0.72, bottom: 164 },
		...lines.map((line, row) => ({
			right: pad + sheet.measure(line, copy),
			top: 174 + row * 28,
			bottom: 196 + row * 28
		})),
		{ right: pad + sheet.measure(tagLine, tags), top: 248, bottom: 266 }
	];
	const clearance = (x: number, y: number) =>
		Math.min(
			smoothstep(30, 62, Math.hypot(x - arrow.x, y - arrow.y)),
			...textBoxes.map((box) =>
				smoothstep(26, 84, Math.hypot(Math.max(0, x - box.right), Math.max(box.top - y, 0, y - box.bottom)))
			)
		);

	const fluid = createFluid(project.seed, FLUID_UNIT);
	const ascii = asciiLayer({
		width,
		height,
		cell: CELL,
		frames: 1,
		seed: project.seed,
		field: (x, y, t) => {
			const gain = smoothstep(190, 470, x + (height - y) * 0.2) * clearance(x, y);
			return gain <= 0 ? 0 : fluid(x, y, t) * gain;
		}
	});

	const body =
		bg.markup +
		ascii.markup +
		sheet.text(String(index + 1).padStart(2, '0'), pad, 54, { ...label, fill: color.foreground }) +
		sheet.text(project.kind.toUpperCase(), pad + 36, 54, { ...label, opacity: 0.72 }) +
		`<circle cx="${arrow.x}" cy="${arrow.y}" r="${arrow.radius}" fill="${color.white}" opacity=".92"/>` +
		sheet.text('↗', arrow.x, arrow.y + 7, {
			size: 20,
			font: 'medium',
			anchor: 'middle',
			fill: color.foreground
		}) +
		sheet.text(project.title, pad - 1, 152, title) +
		lines.map((line, row) => sheet.text(line, pad, 190 + row * 28, copy)).join('') +
		sheet.text(tagLine, pad, 262, tags);

	const left = index % 2 === 0;
	return svg({
		width: width + TILE.gapX,
		height: height + TILE.gapY,
		card: { x: left ? 0 : TILE.gapX, y: TILE.gapY, width, height },
		radius: RADIUS,
		title: `${project.title} — ${project.description}`,
		defs: bg.defs + sheet.render(),
		body
	});
}

export function tiles() {
	const sheet = new GlyphSheet();
	const maxTitleWidth = TILE.width - TILE.pad * 2 - 56;
	const titleSize = Math.min(
		58,
		...projects.map(
			(project) => maxTitleWidth / sheet.measure(project.title, { size: 1, font: 'serif' })
		)
	);
	return Object.fromEntries(
		projects.map((project, index) => [`${project.file}.svg`, tile(project, index, titleSize)])
	);
}

if (import.meta.main) {
	mkdirSync(outDir, { recursive: true });
	const files: Record<string, string> = { 'banner.svg': banner(), ...tiles() };
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(`${outDir}${name}`, content);
		console.log(name, `${(Buffer.byteLength(content) / 1024).toFixed(1)} KB`);
	}
}
