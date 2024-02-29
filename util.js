export function hexToNormalizedRGB(hex) {
	if (hex.startsWith('#')) {
		hex = hex.substring(1);
	}

	let r = parseInt(hex.substring(0, 2), 16) / 255;
	let g = parseInt(hex.substring(2, 4), 16) / 255;
	let b = parseInt(hex.substring(4, 6), 16) / 255;

	return [r, g, b];
}
