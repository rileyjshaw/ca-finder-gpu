/* Here’s how this program works:

It’s based on my prior CA Finder (https://glitch.com/edit/#!/fs-ca-finder?path=script.js),
and its variants. But this time it uses the GPU.

It is a cellular automaton simulation with the following rules:

- Each cell has a state, which has an associated color and a weight.
- The color is output directly to the screen. Forget about that and let’s focus on the weight.
- Weights are typically low integers. When updating to the next frame, each cell sums the weights of its neighbors.
- Every possible sum has an associated rule that maps it to a new state via the rule array.
- The rule array is 1-indexed, so a value of 3 means “change to state 3”. A value of 0 means the cell should remain the same.

So for the following pixel in the center:

1 0 1
1 X 1
0 1 0

we sum the neighbor weights (shown) and get 5. We look that up in the rule array:

[1, 1, 2, 3, 4, 0, 1, 2, 3]

and determine that it should remain unchanged. */

import * as twgl from 'twgl-base.js';
import { tinykeys } from 'tinykeys';
import paletteColors from 'dictionary-of-colour-combinations';

import { hexToNormalizedRGB } from './util.js';

import './style.css';

const palettes = Array.from(
	paletteColors.reduce((map, color, i) => {
		color.combinations.forEach(id => {
			if (map.has(id)) map.get(id).push(i);
			else map.set(id, [i]);
		});
		return map;
	}, new Map()),
	([_name, colorIdxs]) => colorIdxs.map(i => paletteColors[i].hex)
);

tinykeys(window, {
	KeyN: () => {
		setNeighborRange(Math.max(neighborRange - 1, 1));
	},
	KeyM: () => {
		setNeighborRange(neighborRange + 1);
	},
	Space: () => {
		isPaused = !isPaused;
		if (isPaused) cancelAnimationFrame(render);
		else requestAnimationFrame(render);
	},
});

const canvas = document.getElementById('canvas');
const gl = canvas.getContext('webgl2', { antialias: false });
gl.imageSmoothingEnabled = false;

// TODO: Make these mutable.
const CELL_INERTIA = 0.9;
const MAX_WEIGHT = 4;
const getRandomWeight = () => Math.floor(Math.random() * MAX_WEIGHT + 1);
const STATES = palettes[Math.floor(Math.random() * palettes.length)].map(color => ({
	color,
	weight: getRandomWeight(),
}));
const N_STATES = STATES.length;

const weights = STATES.map(state => state.weight); // TODO: Typed array?
let { minWeight, maxWeight } = Array.from(weights).reduce(
	(acc, weight) => {
		if (weight < acc.minWeight) acc.minWeight = weight;
		if (weight > acc.maxWeight) acc.maxWeight = weight;
		return acc;
	},
	{ minWeight: Infinity, maxWeight: -Infinity }
);

// Common vertex shader.
const vsSource = `
#version 300 es
in vec4 position;
out vec2 v_texCoord;

void main() {
	gl_Position = position;
	v_texCoord = position.xy * 0.5 + 0.5; // Map from [-1,1] to [0,1]
}
`;

// Display fragment shader.
const displayFsSource = `
#version 300 es
precision mediump float;
precision mediump usampler2D;

uniform usampler2D u_screenTexture;

in vec2 v_texCoord;
out vec4 FragColor;

void main() {
	uint cellState = texture(u_screenTexture, v_texCoord).r;

	switch(cellState) {
		${STATES.map(
			(state, i) => `case ${i}u: FragColor = vec4(${hexToNormalizedRGB(state.color).join(', ')}, 1.0); break;`
		).join('\n')}
		default: FragColor = vec4(0.0, 0.0, 0.0, 1.0);
	}
}
`;

// Update fragment shader.
// TODO: Rather than regenerating this whenever a key is pressed, it would be better to
//       keep it static and pass in the rules as a texture that can be sampled. Probably
//       need to do the same for the weights.
function getUpdateFsSource(nStates, nRules, gridSize = 1, canvasOffset = '0.0') {
	return `
	#version 300 es
	precision mediump float;
	precision mediump usampler2D;

	uniform usampler2D u_currentStateTexture;
	uniform vec2 u_resolution;
	uniform uint u_weights[${nStates}];
	uniform uint u_minNeighborWeight;
	uniform int u_neighborRange;

	in vec2 v_texCoord;
	out uint State;

	// TODO: Make configurable.
	const uint rules[${nRules}] = uint[${nRules}](${Array.from({ length: nRules }, () =>
		Math.random() < CELL_INERTIA ? 0 : Math.floor(Math.random() * (nStates + 1))
	).join('u, ')}u);

	// Function to compute the state of a cell
	uint getState(vec2 coord) {
		coord = fract(coord); // Wrap the texture coordinates around [0, 1].
		return texture(u_currentStateTexture, coord).r;
	}

	void main() {
		vec2 onePixel = vec2(${gridSize}.0) / u_resolution;
		vec2 canvasOffset = u_resolution * ${canvasOffset};
		uint state = getState(v_texCoord);

		// Count alive neighbors
		uint sum = 0u;
		for (int dx = -u_neighborRange; dx <= u_neighborRange; dx++) {
			for (int dy = -u_neighborRange; dy <= u_neighborRange; dy++) {
				if (dx == 0 && dy == 0) continue;
				sum += u_weights[getState(v_texCoord + canvasOffset + vec2(dx, dy) * onePixel)];
			}
		}
		sum -= u_minNeighborWeight; // Normalize to [0, maxNeighborWeight - minNeighborWeight].

		uint newState = rules[sum];

		if (newState == 0u) {
			State = state;
		} else {
			State = newState - 1u;
		}
	}
	`;
}

const displayProgramInfo = twgl.createProgramInfo(gl, [vsSource, displayFsSource]);
let updateProgramInfos = [];

let neighborRange, nNeighbors, minNeighborWeight, maxNeighborWeight, nRules;
function setNeighborRange(newNeighborRange) {
	neighborRange = newNeighborRange;
	nNeighbors = Math.pow(neighborRange * 2 + 1, 2) - 1;
	minNeighborWeight = minWeight * nNeighbors;
	maxNeighborWeight = maxWeight * nNeighbors;
	nRules = maxNeighborWeight - minNeighborWeight + 1;

	if (updateProgramInfos[0]) {
		updateProgramInfos.forEach(updateProgramInfo => gl.deleteProgram(updateProgramInfo.program));
	}

	updateProgramInfos = [[1, 0.1]].map(args =>
		twgl.createProgramInfo(gl, [vsSource, getUpdateFsSource(N_STATES, nRules, ...args)])
	);
}
setNeighborRange(2);

const arrays = {
	position: {
		numComponents: 2,
		data: [
			-1.0,
			-1.0, // Bottom left.
			1.0,
			-1.0, // Bottom right.
			-1.0,
			1.0, // Top left.
			1.0,
			1.0, // Top right.
		],
	},
};
const bufferInfo = twgl.createBufferInfoFromArrays(gl, arrays);

function createRandomTexture(gl, width, height) {
	const size = width * height;
	const data = new Uint8Array(size);
	for (let i = 0; i < size; ++i) {
		// Generate a random state.
		const state = Math.floor(Math.random() * N_STATES);
		data[i] = state;
	}

	return twgl.createTexture(gl, {
		width,
		height,
		type: gl.UNSIGNED_BYTE,
		format: gl.RED_INTEGER,
		internalFormat: gl.R8UI,
		minMag: gl.NEAREST,
		wrap: gl.CLAMP_TO_EDGE,
		src: data,
	});
}

// Ping-Pong setup.
let textures = [];
let fbos = [];
function initBuffers() {
	textures = [
		createRandomTexture(gl, canvas.width, canvas.height),
		createRandomTexture(gl, canvas.width, canvas.height),
	];

	fbos = textures.map(texture => twgl.createFramebufferInfo(gl, [{ attachment: texture }]));
}

function resize() {
	if (twgl.resizeCanvasToDisplaySize(gl.canvas)) {
		initBuffers(); // Reinitialize textures and FBOs on resize.
		gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
	}
}

function runUpdateProgram(programInfo) {
	gl.bindFramebuffer(gl.FRAMEBUFFER, fbos[nextStateTextureIndex].framebuffer);
	gl.useProgram(programInfo.program);
	twgl.setBuffersAndAttributes(gl, programInfo, bufferInfo);

	// Pass data to the shader.
	twgl.setUniforms(programInfo, {
		u_weights: weights,
		u_minNeighborWeight: minNeighborWeight,
		u_neighborRange: neighborRange,
		u_currentStateTexture: textures[1 - nextStateTextureIndex], // Send the current state for feedback.
		u_resolution: [gl.canvas.width, gl.canvas.height],
	});
	twgl.drawBufferInfo(gl, bufferInfo, gl.TRIANGLE_STRIP);
}

let nextStateTextureIndex = 0;
let nextAnimationFrame = null;
let isPaused = false;
function render(time) {
	time /= 1000; // Convert time to seconds.
	resize();

	// 1. Update the game state: Render to off-screen texture.
	updateProgramInfos.forEach(updateProgramInfo => {
		runUpdateProgram(updateProgramInfo);

		// Ping pong!
		nextStateTextureIndex = 1 - nextStateTextureIndex;
	});

	// 2. Display the updated state: Render to the screen.
	gl.bindFramebuffer(gl.FRAMEBUFFER, null); // Bind the default framebuffer (the screen).
	gl.useProgram(displayProgramInfo.program);
	twgl.setBuffersAndAttributes(gl, displayProgramInfo, bufferInfo);

	// Pass data to the display shader.
	twgl.setUniforms(displayProgramInfo, {
		u_screenTexture: textures[1 - nextStateTextureIndex], // Send the updated state.
	});
	twgl.drawBufferInfo(gl, bufferInfo, gl.TRIANGLE_STRIP);

	if (!isPaused) nextAnimationFrame = requestAnimationFrame(render);
}
nextAnimationFrame = requestAnimationFrame(render);
