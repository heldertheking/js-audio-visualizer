@group(0) @binding(0) var<storage, read> audioData: array<u32>;

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
    @location(1) volume: f32,
    @location(2) currentDimensions: vec2f, // Sends the active width/height to the pixel painter
};

struct VisualSettings {
    barWidthPercentage: f32,
    centerHorizonY: f32, // -0.95 bottom, 0.0 center
    baseColor: vec3f,
    peakColor: vec3f,
};
@group(0) @binding(1) var<uniform> settings: VisualSettings;

@vertex
fn vs_main(
    @builtin(vertex_index) vertexIndex: u32,
    @builtin(instance_index) barIndex: u32
) -> VertexOutput {
    var output: VertexOutput;

    // Extract byte data
    let wordIndex = barIndex / 4u;
    let byteOffset = barIndex % 4u;
    let packedValue = audioData[wordIndex];
    let rawVolume = (packedValue >> (byteOffset * 8u)) & 0xFFu;
    let normalizedVolume = f32(rawVolume) / 255.0;

    // DYNAMIC ANCHORING MATH
    let isCentered = settings.centerHorizonY > -0.5;
    let yMin = select(0.0, -0.5, isCentered);
    let yMax = select(1.0,  0.5, isCentered);

    let positions = array<vec2f, 6>(
        vec2f(-0.5, yMin), vec2f( 0.5, yMin), vec2f(-0.5, yMax),
        vec2f(-0.5, yMax), vec2f( 0.5, yMin), vec2f( 0.5, yMax)
    );

    let rawPos = positions[vertexIndex];
    output.uv = rawPos;
    output.volume = normalizedVolume;

    // FIXED GRID LAYOUT
    let totalBars = 32.0;
    let totalWidth = 1.9;

    let cellSize = totalWidth / totalBars;
    let barWidth = cellSize * settings.barWidthPercentage;
    let xCenter = -0.95 + (f32(barIndex) * cellSize) + (cellSize * 0.5);
    let finalX = xCenter + (rawPos.x * barWidth);

    let activeHeight = max(0.02, normalizedVolume * 1.6);
    let finalY = settings.centerHorizonY + (rawPos.y * activeHeight);

    // Pass the real physical pixel sizes down so the fragment shader knows the exact aspect ratio
    output.currentDimensions = vec2f(barWidth, activeHeight);

    output.position = vec4f(finalX, finalY, 0.0, 1.0);
    return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
    // Convert local uv coordinates into real physical space measurements
    let w = input.currentDimensions.x;
    let h = input.currentDimensions.y;

    // Transform coordinates so (0,0) sits directly in the center of the column box
    let pos = vec2f(input.uv.x * w, (input.uv.y - 0.5) * h);

    // ====================================================================
    // PERFECT ASPECT-AWARE CAPSULE (SDF Blueprint)
    // ====================================================================
    let isCentered = settings.centerHorizonY > -0.5;

    // The radius of our rounded dome cap can never exceed half of the bar width
    let r = w * 0.5;

    var dist: f32 = 0.0;
    if (isCentered) {
        // Round top and bottom symmetrically
        let h_half = h * 0.5;
        let cap_center_y = max(0.0, h_half - r);
        let p = vec2f(pos.x, abs(pos.y) - cap_center_y);
        dist = select(abs(p.x) - r, length(p) - r, p.y > 0.0);
    } else {
        // Shift geometry coordinates to handle bottom floor anchoring
        let posBottom = vec2f(input.uv.x * w, input.uv.y * h);
        let cap_center_y = max(0.0, h - r);
        let p = vec2f(posBottom.x, posBottom.y - cap_center_y);
        dist = select(abs(p.x) - r, length(p) - r, p.y > 0.0);
    }

    // Anti-alias edge profiling using smoothstep drops jagged lines smoothly
    // The divisor 0.005 handles sub-pixel sharpening based on camera boundaries
    let alphaMask = 1.0 - smoothstep(-0.005, 0.0, dist);
    if (alphaMask <= 0.0) { discard; }

    // DYNAMIC COLOR BLENDING
    let lowColor = settings.baseColor;
    let highColor = settings.peakColor;

    let localY = input.uv.y;
    let colorWeight = select(localY * 0.5 + input.volume * 0.5, abs(localY) * 1.0 + input.volume * 0.5, isCentered);
    let mixedColor = mix(lowColor, highColor, clamp(colorWeight, 0.0, 1.0));

    // CLEAN SIDE GLOW GLOSS
    let horizontalGlow = smoothstep(0.5, 0.15, abs(input.uv.x));
    let finalAlpha = alphaMask * horizontalGlow * mix(0.6, 1.0, input.volume);

    return vec4f(mixedColor, finalAlpha);
}