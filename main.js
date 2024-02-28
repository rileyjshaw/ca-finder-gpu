/* Here’s how this program works:

It’s based on my prior CA Finder (https://glitch.com/edit/#!/fs-ca-finder?path=script.js),
and its variants. But this time it uses the GPU.

It is a cellular automaton simulation with the following rules:

- Each cell has a state, which has an associated color and a weight.
- The color is output directly to the screen. Forget about that and let’s focus on the weight.
- Weights are typically low integers. When updating to the next frame, each cell sums the weights of its neighbors.
- Every possible sum has an associated rule that maps it to a new state via the rule array.
- Let’s say there are 4 possible states. A value of 2 in the rule array means “change to state 3” (0-indexed). A value of 4 means the cell should remain the same.

So for the following pixel in the center:

1 0 1
1 X 1
0 1 0

we sum the neighbor weights (shown) and get 5. We look that up in the rule array:

[1, 1, 2, 3, 4, 0, 1, 2, 3]

and determine that it should change to state 0.

*/

import * as twgl from 'twgl-base.js';
import './style.css';

const canvas = document.getElementById('canvas');
const gl = canvas.getContext('webgl2', { antialias: false });
gl.imageSmoothingEnabled = false;

// TODO: Make these configurable. It’s hardcoded a few places for now.
const WEIGHTS = [1, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 1, 0];
const RULES = [
	16, 8, 16, 1, 16, 8, 6, 13, 16, 11, 16, 0, 2, 16, 2, 6, 1, 7, 2, 6, 7, 11, 12, 11, 16, 7, 14, 0, 0, 16, 14, 16, 8,
	16, 9, 1, 5, 16, 6, 7, 13, 9, 16, 16, 15, 9, 4, 8, 10, 15,
];
const N_STATES = 2;

/* TODO: Unused for now.

const nNeighbors = Math.pow(neighborRange * 2, 2);
let { minWeight, maxWeight } = Array.from(weights).reduce(
	(acc, weight) => {
		if (weight < acc.minWeight) acc.minWeight = weight;
		if (weight > acc.maxWeight) acc.maxWeight = weight;
		return acc;
	},
	{ minWeight: Infinity, maxWeight: -Infinity }
);
minWeight *= nNeighbors;
maxWeight *= nNeighbors;

*/

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

    if (cellState > 0u) {
        FragColor = vec4(1.0, 0.8, 0.5, 1.0); // Example: Alive cells as yellow
    } else {
        FragColor = vec4(0.0, 0.0, .2, 1.0); // Example: Dead cells as blue
    }
}
`;

// Update fragment shader.
function getUpdateFsSource() {
	return `
	#version 300 es
	precision mediump float;
	precision mediump usampler2D;

	uniform usampler2D u_currentStateTexture;
	uniform vec2 u_resolution;
	uniform int u_weights[4];
	uniform int u_neighborRange;

	in vec2 v_texCoord;
	out uint State;

	// Function to compute the state of a cell
	uint getWeight(vec2 coord) {
		coord = fract(coord); // Wrap the texture coordinates around [0, 1].
		// int weightIdx = int(texture(u_currentStateTexture, coord).r * 255.0);
		// return weights[weightIdx];
		return texture(u_currentStateTexture, coord).r;
	}

	void main() {
		vec2 onePixel = vec2(1.0) / u_resolution;
		uint state = getWeight(v_texCoord);

		// Count alive neighbors
		uint sum = 0u;
		for (int dx = -u_neighborRange; dx <= u_neighborRange; dx++) {
			for (int dy = -u_neighborRange; dy <= u_neighborRange; dy++) {
				if (dx < -u_neighborRange || dx > u_neighborRange || dy < -u_neighborRange || dy > u_neighborRange) continue;
				if (dx == 0 && dy == 0) continue;
				sum += getWeight(v_texCoord + vec2(dx, dy) * onePixel);
			}
		}
		// sum -= $ {minWeight}.0; // Normalize to [0, $ {maxWeight - minWeight}].

		// Game of Life rules
		if (state == 1u) { // Alive
			if (sum < 2u || sum > 3u) state = 0u; // Die due to under/overpopulation
		} else { // Dead
			if (sum == 3u) state = 1u; // Become alive through reproduction
		}

		State = state;
	}
	`;
}

let updateProgramInfo = twgl.createProgramInfo(gl, [vsSource, getUpdateFsSource()]);
const displayProgramInfo = twgl.createProgramInfo(gl, [vsSource, displayFsSource]);

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
	const size = width * height; // 4 bytes per pixel for RGBA
	const data = new Uint8Array(size);
	for (let i = 0; i < size; ++i) {
		// Generate a random state.
		const state = Math.random() < 0.5 ? 0 : 1;
		// const state = Math.floor(Math.random() * N_STATES);
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

let currentFboIndex = 0;
function render(time) {
	time /= 1000; // Convert time to seconds.

	// Resize handling
	resize();

	// 1. Update the game state: Render to off-screen texture
	const nextFboIndex = (currentFboIndex + 1) % 2;
	gl.bindFramebuffer(gl.FRAMEBUFFER, fbos[nextFboIndex].framebuffer);
	gl.useProgram(updateProgramInfo.program);
	twgl.setBuffersAndAttributes(gl, updateProgramInfo, bufferInfo);

	// Set uniforms for the update shader, including the current state texture
	twgl.setUniforms(updateProgramInfo, {
		u_weights: [1, 1, 0, 1],
		u_neighborRange: 1,
		u_currentStateTexture: textures[currentFboIndex], // Use the current state
		u_resolution: [gl.canvas.width, gl.canvas.height],
	});
	twgl.drawBufferInfo(gl, bufferInfo, gl.TRIANGLE_STRIP);

	// 2. Display the updated state: Render to the screen
	gl.bindFramebuffer(gl.FRAMEBUFFER, null); // Bind the default framebuffer (the screen)
	gl.useProgram(displayProgramInfo.program);
	twgl.setBuffersAndAttributes(gl, displayProgramInfo, bufferInfo);

	// Set uniforms for the display shader, including the updated state texture
	twgl.setUniforms(displayProgramInfo, {
		u_screenTexture: textures[nextFboIndex], // Use the updated state
	});
	twgl.drawBufferInfo(gl, bufferInfo, gl.TRIANGLE_STRIP);

	// Prepare for the next frame
	currentFboIndex = nextFboIndex;

	requestAnimationFrame(render);
}
requestAnimationFrame(render);
