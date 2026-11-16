function mulberry32(seed: number) {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function createNoise(seed: number) {
	const random = mulberry32(seed);
	const perm = Array.from({ length: 256 }, (_, i) => i);
	for (let i = 255; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[perm[i], perm[j]] = [perm[j], perm[i]];
	}
	const p = (i: number) => perm[i & 255];
	const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
	const mix = (a: number, b: number, t: number) => a + (b - a) * t;
	const grad = (hash: number, x: number, y: number, z: number) => {
		const h = hash & 15;
		const u = h < 8 ? x : y;
		const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
		return (h & 1 ? -u : u) + (h & 2 ? -v : v);
	};

	return (x: number, y: number, z: number, period: number) => {
		const xi = Math.floor(x);
		const yi = Math.floor(y);
		const zi = Math.floor(z);
		const xf = x - xi;
		const yf = y - yi;
		const zf = z - zi;
		const z0 = ((zi % period) + period) % period;
		const z1 = (z0 + 1) % period;
		const u = fade(xf);
		const v = fade(yf);
		const w = fade(zf);
		const corner = (dx: number, dy: number, zz: number, dz: number) =>
			grad(p(p(p(xi + dx) + yi + dy) + zz), xf - dx, yf - dy, zf - dz);
		return mix(
			mix(mix(corner(0, 0, z0, 0), corner(1, 0, z0, 0), u), mix(corner(0, 1, z0, 0), corner(1, 1, z0, 0), u), v),
			mix(mix(corner(0, 0, z1, 1), corner(1, 0, z1, 1), u), mix(corner(0, 1, z1, 1), corner(1, 1, z1, 1), u), v),
			w
		);
	};
}

export const smoothstep = (edge0: number, edge1: number, value: number) => {
	const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
	return t * t * (3 - 2 * t);
};

const CHARSET = ' .~+voe#';
const LAYER_PERIOD = 2;

function createFbm(seed: number) {
	const noise = createNoise(seed);
	return (x: number, y: number, layer: number, octaves = 3) => {
		let sum = 0;
		let amplitude = 0.5;
		let frequency = 1;
		let total = 0;
		for (let octave = 0; octave < octaves; octave++) {
			sum +=
				amplitude *
				noise(x * frequency + octave * 19.1, y * frequency + octave * 7.7, layer + octave * 3.3, LAYER_PERIOD);
			total += amplitude;
			amplitude *= 0.5;
			frequency *= 2;
		}
		return sum / total;
	};
}

export type Field = (x: number, y: number, t: number) => number;

export function createFluid(seed: number, unit: number): Field {
	const orbit = 0.045;
	const sway = 0.08;
	const level = 0.04;
	const fbm = createFbm(seed);
	// Every time-dependent offset travels a closed circle, so t = 0 and t = 1 match and the loop is seamless.
	const scalar = (u: number, v: number, t: number) => {
		const angle = t * Math.PI * 2;
		const orbitX = Math.cos(angle) * orbit;
		const orbitY = Math.sin(angle) * orbit;
		const layer = Math.sin(angle) * sway;
		const warpX = fbm(u * 0.7 + orbitX, v * 0.7 + orbitY, layer, 2);
		const warpY = fbm(u * 0.7 + 31.4 - orbitY, v * 0.7 + 11.7 + orbitX, layer, 2);
		return fbm(u * 0.42 + warpX * 2.6, v * 0.7 + warpY * 2.6, layer);
	};
	const step = 0.012;

	return (px, py, t) => {
		const u = px / unit;
		const v = py / unit;
		const value = scalar(u, v, t);
		const slope = Math.max(
			Math.hypot((scalar(u + step, v, t) - value) / step, (scalar(u, v + step, t) - value) / step),
			0.05
		);
		const width = 0.06 + 0.14 * smoothstep(-0.22, 0.24, fbm(u * 0.5 + 9, v * 0.5 + 4, 0, 2));
		return 1 - smoothstep(0, width, Math.abs(value - level) / slope);
	};
}

export type AsciiOptions = {
	width: number;
	height: number;
	cell: number;
	frames: number;
	seed: number;
	field: Field;
};

export function asciiFrames({ width, height, cell, frames, seed, field }: AsciiOptions) {
	const flicker = mulberry32(seed * 7 + 1);
	const cols = Math.ceil(width / cell);
	const rows = Math.ceil(height / cell);
	return Array.from({ length: frames }, (_, frame) =>
		Array.from({ length: rows }, (_, row) => {
			let line = '';
			for (let col = 0; col < cols; col++) {
				const density = field((col + 0.5) * cell, (row + 0.5) * cell, frame / frames);
				const lit = density < 0.06 ? 0 : Math.min(1, Math.max(0, density + (flicker() - 0.5) * 0.05));
				line += CHARSET[Math.min(CHARSET.length - 1, Math.floor(lit * (CHARSET.length - 0.001)))];
			}
			return line;
		})
	);
}
