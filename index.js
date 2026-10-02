const canvas = document.querySelector('canvas');
const context = canvas.getContext("webgpu");

const FFT_SIZE = 64; // 64 size = 32 individual frequency bars

let device;
let preferredFormat;

// WebGPU Resources
let audioBuffer;
let pipeline;
let bindGroup;
let settingsBuffer;

// State Management
let settingsData = new Float32Array([
    0.50,           // [0] barWidthPercentage
    -0.95,          // [1] centerHorizonY
    0.0, 0.0,       //, [3] MANDATORY PADDING GAPS (WebGPU alignment)
    0.0, 1.0, 0.5,  //, [5], [6] baseColor (Teal/Green)
    0.0,            // [7] Padding slot to bring peakColor to a 16-byte boundary
    1.0, 0.0, 0.5,  //, [9], [10] peakColor (Hot Magenta)
    0.0             // [11] End padding so the full array matches 48 bytes
]);

let isCapturing = false;


// Audio Configuration
const dataArray = new Uint8Array(FFT_SIZE / 2);

// DAMPING ARRAY: Holds the actual drawn heights
const smoothArray = new Float32Array(FFT_SIZE / 2);

async function initWebGPU() {
    if (!navigator.gpu) {
        console.error("WebGPU is not supported on this browser.");
        return;
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
        console.error("No appropriate GPU adapter found.");
        return;
    }
    device = await adapter.requestDevice();
    preferredFormat = navigator.gpu.getPreferredCanvasFormat();

    context.configure({
        device: device,
        format: preferredFormat,
        alphaMode: 'opaque'
    });

    audioBuffer = device.createBuffer({
        size: dataArray.length,
        usage: 128 | 8 // STORAGE | COPY_DST
    });

    /*
    - 2x scalar floats + 2x padding floats = 16 bytes
    - 1x vec3f base color + 1x padding float = 16 bytes
    - 1x vec3f peak color + 1x padding float = 16 bytes
    Total = 48 bytes
     */
    settingsBuffer = device.createBuffer({
        size: 48,
        usage: 64 | 8 // UNIFORM | COPY_DST
    })

    const response = await fetch('./shader.wgsl')
    if (!response.ok) throw new Error(`Could not find shader file`);

    const shaderModule = device.createShaderModule({
        code: await response.text()
    });

    pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: {module: shaderModule, entryPoint: 'vs_main'},
        fragment: {
            module: shaderModule,
            entryPoint: 'fs_main',
            targets: [{
                format: preferredFormat,
                blend: {
                    color: {operation: 'add', srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha'},
                    alpha: {operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha'}
                }
            }]
        },
        primitive: {topology: 'triangle-list'},
    });

    bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
            {binding: 0, resource: {buffer: audioBuffer}}, // Audio Array
            {binding: 1, resource: {buffer: settingsBuffer}},
        ],
    });

    console.log("WebGPU resources fully ready with True Audio Analysis!");
    startupAnimation()
}

initWebGPU();

async function startAudioCapture() {
    if (!device) return;

    isCapturing = true;
    if (startupAnimationId) {
        cancelAnimationFrame(startupAnimationId);
    }

    try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: {echoCancellation: false, noiseSuppression: false, autoGainControl: false}
        });

        const audioTracks = stream.getAudioTracks();
        if (audioTracks && audioTracks.length > 0) {
            const audioContext = new AudioContext();
            const source = audioContext.createMediaStreamSource(new MediaStream([audioTracks[0]]));
            const analyser = audioContext.createAnalyser();
            source.connect(analyser);
            analyser.fftSize = FFT_SIZE;

            device.queue.writeBuffer(settingsBuffer, 0, settingsData)

            function updateAudioData() {
                requestAnimationFrame(updateAudioData);
                analyser.getByteFrequencyData(dataArray);

                // ====================================================================
                // AUTHENTIC LERP DAMPING (No High Frequency Fake Boost)
                // ====================================================================
                for (let i = 0; i < dataArray.length; i++) {
                    let targetHeight = dataArray[i] / 255.0;

                    if (targetHeight >= smoothArray[i]) {
                        // Sound levels spiking up: follow it instantly
                        smoothArray[i] = targetHeight;
                    } else {
                        // Sound levels dropping: ease down smoothly via linear interpolation (lerp)
                        // 0.15 controls decay speed. Lower numbers make it slide down even slower.
                        smoothArray[i] += (targetHeight - smoothArray[i]) * 0.15;
                    }

                    dataArray[i] = Math.floor(smoothArray[i] * 255);
                }

                device.queue.writeBuffer(audioBuffer, 0, dataArray);

                const canvasTexture = context.getCurrentTexture().createView();
                const commandEncoder = device.createCommandEncoder();

                const renderPass = commandEncoder.beginRenderPass({
                    colorAttachments: [{
                        view: canvasTexture,
                        clearValue: {r: 0.055, g: 0.055, b: 0.098, a: 1.0},
                        loadOp: 'clear',
                        storeOp: 'store',
                    }]
                });

                renderPass.setPipeline(pipeline);
                renderPass.setBindGroup(0, bindGroup);
                renderPass.draw(6, 32);
                renderPass.end();
                device.queue.submit([commandEncoder.finish()]);
            }

            updateAudioData();
        }
    } catch (err) {
        isCapturing = false;
        console.error(err);
    }
}

const hexToRgb = (hex) => {
    return {
        r: parseInt(hex.slice(1, 3), 16) / 255,
        g: parseInt(hex.slice(3, 5), 16) / 255,
        b: parseInt(hex.slice(5, 7), 16) / 255,
    }
}

document.querySelector('#startButton').addEventListener('click', startAudioCapture);
function applySetting(element) {
    switch (element.id) {
        case 'barWidthPercentage':
            settingsData[0] = element.value / 100;
            break;

        case 'centerHorizonY':
            settingsData[1] = element.checked ? 0.0 : -0.95;
            break;

        case 'baseColor': {
            const baseRGB = hexToRgb(element.value);
            settingsData[4] = baseRGB.r;
            settingsData[5] = baseRGB.g;
            settingsData[6] = baseRGB.b;
            break;
        }

        case 'peakColor': {
            const peakRGB = hexToRgb(element.value);
            settingsData[8] = peakRGB.r;
            settingsData[9] = peakRGB.g;
            settingsData[10] = peakRGB.b;
            break;
        }
    }
}

function syncSettingsBuffer() {
    if (device && settingsBuffer) {
        device.queue.writeBuffer(settingsBuffer, 0, settingsData);
    }
}

function syncUi() {
    document.querySelector('#barWidthValue')
        .textContent = Math.round(settingsData[0] * 100) + "%"
}

document.querySelectorAll('input').forEach(input => {
    applySetting(input);

    input.addEventListener('input', (e) => {
        applySetting(e.target);
        syncSettingsBuffer();
        syncUi()
    });
});

syncSettingsBuffer();
syncUi();

const settingsToggle = document.querySelector('#settingsToggle');
const settingsPanel = document.querySelector('#settingsPanel');
settingsToggle.addEventListener('click', () => {
    settingsPanel.classList.toggle('open');
    settingsToggle.classList.toggle('active');
});

let startupAnimationId = null;

function startupAnimation() {
    // 32-element typed array with a single active bar
    const animData = new Uint8Array(32);
    animData[0] = 255;

    let lastTime = 0;
    const intervalMs = 50; // Controls scroll speed (ms per step)

    function loop(now) {
        if (isCapturing) return; // Stop animation when audio starts

        if (now - lastTime > intervalMs) {
            lastTime = now;

            // In-place rotate last element to the front inside the TypedArray
            const lastVal = animData[animData.length - 1];
            animData.copyWithin(1, 0, animData.length - 1);
            animData[0] = lastVal;

            // Write typed array to GPU and render
            device.queue.writeBuffer(audioBuffer, 0, animData);
            drawVisualizer();
        }

        startupAnimationId = requestAnimationFrame(loop);
    }

    startupAnimationId = requestAnimationFrame(loop);
}

function drawVisualizer() {
    const canvasTexture = context.getCurrentTexture().createView();
    const commandEncoder = device.createCommandEncoder();

    const renderPass = commandEncoder.beginRenderPass({
        colorAttachments: [{
            view: canvasTexture,
            clearValue: { r: 0.055, g: 0.055, b: 0.098, a: 1.0 },
            loadOp: 'clear',
            storeOp: 'store',
        }]
    });

    renderPass.setPipeline(pipeline);
    renderPass.setBindGroup(0, bindGroup);
    renderPass.draw(6, 32);
    renderPass.end();

    device.queue.submit([commandEncoder.finish()]);
}