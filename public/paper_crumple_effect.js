/**
 * Vatsom — PaperCrumple 3D WebGL Effect (Zero-Latency Pre-Warmed Engine)
 * Adapted from React Bits <PaperCrumple />
 *
 * EASY FALLBACK INSTRUCTIONS:
 * - To disable temporarily: click "CRUMPLE: ON/OFF" in the Order Parchment header,
 *   or set `window.ENABLE_PAPER_CRUMPLE = false;`.
 * - To remove completely: delete `<script src="paper_crumple_effect.js"></script>` from
 *   `vatsom_premium_oils.html`.
 */

(function () {
    'use strict';

    window.ENABLE_PAPER_CRUMPLE = true;

    const spring = (value = 0) => ({ value, target: value, velocity: 0 });
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

    function advance(s, dt, duration) {
        const omega = 8 / Math.max(0.06, duration);
        const offset = s.value - s.target;
        const term = s.velocity + omega * offset;
        const decay = Math.exp(-omega * dt);
        s.value = s.target + (offset + term * dt) * decay;
        s.velocity = (s.velocity - omega * term * dt) * decay;
    }

    function randomSource(seed) {
        let value = seed | 0;
        return () => {
            value |= 0;
            value = (value + 0x6d2b79f5) | 0;
            let n = Math.imul(value ^ (value >>> 15), 1 | value);
            n = (n + Math.imul(n ^ (n >>> 7), 61 | n)) ^ n;
            return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
        };
    }

    // Standard slip aspect & mesh resolution
    const BASE_WIDTH = 380;
    const BASE_HEIGHT = 72;
    const ASPECT = BASE_HEIGHT / BASE_WIDTH;
    const SHORT_SIDE = Math.min(1, ASPECT);
    const COLUMNS = 16;
    const ROWS = 5;
    const SHARPNESS = 0.68;

    // Pre-warmed state (shared WebGLRenderer, scene, and pre-baked keyframe meshes)
    let sharedEngine = null;
    const bakedPaths = [];

    function buildAndBakeCrumplePath(seed) {
        const rng = randomSource(seed);
        const foldCount = 7;
        const wrinkleDepth = 0.95;
        const count = (COLUMNS + 1) * (ROWS + 1);
        const rest = new Float32Array(count * 3);
        const uvs = new Float32Array(count * 2);
        const triangles = [];

        for (let row = 0; row <= ROWS; row++) {
            for (let col = 0; col <= COLUMNS; col++) {
                const index = row * (COLUMNS + 1) + col;
                const u = (col + (col > 0 && col < COLUMNS ? (rng() - 0.5) * 0.42 : 0)) / COLUMNS;
                const v = (row + (row > 0 && row < ROWS ? (rng() - 0.5) * 0.42 : 0)) / ROWS;
                rest[index * 3] = u - 0.5;
                rest[index * 3 + 1] = (v - 0.5) * ASPECT;
                uvs[index * 2] = u;
                uvs[index * 2 + 1] = v;
                if (col < COLUMNS && row < ROWS) {
                    const a = index,
                        b = index + 1,
                        c = index + COLUMNS + 1,
                        d = c + 1;
                    if (rng() > 0.5) triangles.push(a, b, d, a, d, c);
                    else triangles.push(a, b, c, b, d, c);
                }
            }
        }

        const points = Float64Array.from(rest);
        const previous = Float64Array.from(rest);
        const edges = [];
        const hinges = [];
        const adjacency = new Map();
        const guides = Array.from({ length: foldCount }, () => {
            const angle = rng() * Math.PI * 2;
            return { x: Math.cos(angle), y: Math.sin(angle), phase: rng() * Math.PI * 2, weight: rng() * 0.6 + 0.4 };
        });

        for (let t = 0; t < triangles.length; t += 3) {
            for (let k = 0; k < 3; k++) {
                const a = triangles[t + k],
                    b = triangles[t + ((k + 1) % 3)],
                    opposite = triangles[t + ((k + 2) % 3)];
                const key = Math.min(a, b) * count + Math.max(a, b);
                const other = adjacency.get(key);
                if (!other) {
                    adjacency.set(key, { a, b, opposite });
                    const length = Math.hypot(rest[a * 3] - rest[b * 3], rest[a * 3 + 1] - rest[b * 3 + 1]);
                    edges.push(a * 3, b * 3, length);
                } else {
                    const c = other.opposite * 3,
                        d = opposite * 3;
                    const length = Math.hypot(rest[c] - rest[d], rest[c + 1] - rest[d + 1]);
                    const mx = (rest[c] + rest[d]) * 0.5,
                        my = (rest[c + 1] + rest[d + 1]) * 0.5;
                    let weakness = 0;
                    for (const guide of guides) {
                        const distance = Math.abs(Math.sin(((mx * guide.x + my * guide.y) / SHORT_SIDE) * 4 + guide.phase));
                        weakness = Math.max(weakness, Math.exp(-distance * distance * 80) * guide.weight);
                    }
                    hinges.push(c, d, length, 0.12 + (1 - weakness) * 0.75);
                }
            }
        }

        const spacing = Math.sqrt((SHORT_SIDE * SHORT_SIDE) / count);
        const rawSamples = [Float32Array.from(rest)];
        const frameCount = 24;
        const stepsPerFrame = 2;
        const totalSteps = frameCount * stepsPerFrame;
        let initialRadius = 0;
        for (let i = 0; i < rest.length; i += 3) {
            initialRadius = Math.max(initialRadius, Math.hypot(rest[i] / 0.94, rest[i + 1] / 1.02));
        }
        initialRadius *= 1.02;

        function constrain(list, stride, stiffness, reverse) {
            for (let n = 0; n < list.length; n += stride) {
                const edge = reverse ? list.length - stride - n : n;
                const a = list[edge],
                    b = list[edge + 1];
                const dx = points[b] - points[a],
                    dy = points[b + 1] - points[a + 1],
                    dz = points[b + 2] - points[a + 2];
                const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (length < 0.000001) continue;
                const weight = stride === 4 ? list[edge + 3] : 1;
                const amount = (1 - list[edge + 2] / length) * 0.5 * stiffness * weight;
                points[a] += dx * amount;
                points[b] -= dx * amount;
                points[a + 1] += dy * amount;
                points[b + 1] -= dy * amount;
                points[a + 2] += dz * amount;
                points[b + 2] -= dz * amount;
            }
        }

        for (let step = 1; step <= totalSteps; step++) {
            const progress = step / totalSteps;
            const compression = progress * progress * (3 - 2 * progress);
            const radius = initialRadius * (1 - compression) + SHORT_SIDE * (0.24 - wrinkleDepth * 0.03) * compression;
            for (let i = 0; i < points.length; i += 3) {
                const x = rest[i] / SHORT_SIDE,
                    y = rest[i + 1] / SHORT_SIDE;
                let buckle = 0;
                for (const guide of guides) {
                    buckle += Math.sin((x * guide.x + y * guide.y) * 5 + guide.phase) * guide.weight;
                }
                for (let axis = 0; axis < 3; axis++) {
                    const velocity = (points[i + axis] - previous[i + axis]) * 0.55;
                    previous[i + axis] = points[i + axis];
                    points[i + axis] += clamp(velocity, -spacing * 0.15, spacing * 0.15);
                }
                points[i + 2] += (buckle / foldCount) * SHORT_SIDE * 0.0014 * Math.sin(progress * Math.PI);
            }
            for (let pass = 0; pass < 10; pass++) {
                constrain(hinges, 4, 0.45 * (1 - SHARPNESS * 0.4), pass % 2 === 0);
                for (let i = 0; i < points.length; i += 3) {
                    const x = points[i] / 0.94,
                        y = points[i + 1] / 1.02,
                        z = points[i + 2] / 0.86;
                    const distance = Math.hypot(x, y, z);
                    if (distance > radius) {
                        const push = (1 - radius / distance) * 0.55;
                        points[i] -= points[i] * push;
                        points[i + 1] -= points[i + 1] * push;
                        points[i + 2] -= points[i + 2] * push;
                    }
                }
                constrain(edges, 3, 1, pass % 2 !== 0);
            }
            if (step % stepsPerFrame === 0) {
                rawSamples.push(Float32Array.from(points));
            }
        }

        // Pre-bake expanded renderPositions and renderNormals for every sample frame
        // so runtime animation does zero normal math!
        const incidentFaces = Array.from({ length: count }, () => []);
        const renderUvs = new Float32Array(triangles.length * 2);
        for (let i = 0; i < triangles.length; i++) {
            renderUvs[i * 2] = uvs[triangles[i] * 2];
            renderUvs[i * 2 + 1] = uvs[triangles[i] * 2 + 1];
            incidentFaces[triangles[i]].push(Math.floor(i / 3) * 3);
        }

        const faceNormals = new Float32Array(triangles.length);
        const bakedFrames = rawSamples.map(pos => {
            const rPos = new Float32Array(triangles.length * 3);
            const rNorm = new Float32Array(triangles.length * 3);

            for (let face = 0; face < triangles.length; face += 3) {
                const a = triangles[face] * 3,
                    b = triangles[face + 1] * 3,
                    c = triangles[face + 2] * 3;
                const bx = pos[b] - pos[a],
                    by = pos[b + 1] - pos[a + 1],
                    bz = pos[b + 2] - pos[a + 2];
                const cx = pos[c] - pos[a],
                    cy = pos[c + 1] - pos[a + 1],
                    cz = pos[c + 2] - pos[a + 2];
                const nx = by * cz - bz * cy,
                    ny = bz * cx - bx * cz,
                    nz = bx * cy - by * cx;
                const len = Math.hypot(nx, ny, nz) || 1;
                faceNormals[face] = nx / len;
                faceNormals[face + 1] = ny / len;
                faceNormals[face + 2] = nz / len;
            }

            for (let i = 0; i < triangles.length; i++) {
                const source = triangles[i] * 3;
                const face = Math.floor(i / 3) * 3;
                let nx = 0,
                    ny = 0,
                    nz = 0;
                for (const neighbor of incidentFaces[triangles[i]]) {
                    const dot =
                        faceNormals[face] * faceNormals[neighbor] +
                        faceNormals[face + 1] * faceNormals[neighbor + 1] +
                        faceNormals[face + 2] * faceNormals[neighbor + 2];
                    const weight = THREE.MathUtils.smoothstep(dot, 0.82, 0.98);
                    nx += faceNormals[neighbor] * weight;
                    ny += faceNormals[neighbor + 1] * weight;
                    nz += faceNormals[neighbor + 2] * weight;
                }
                const len = Math.hypot(nx, ny, nz) || 1;
                rPos[i * 3] = pos[source];
                rPos[i * 3 + 1] = pos[source + 1];
                rPos[i * 3 + 2] = pos[source + 2];
                rNorm[i * 3] = nx / len;
                rNorm[i * 3 + 1] = ny / len;
                rNorm[i * 3 + 2] = nz / len;
            }
            return { rPos, rNorm };
        });

        return { bakedFrames, renderUvs, vertexCount: triangles.length };
    }

    // Initialize persistent WebGL context & pre-compile shaders at idle time
    function ensureSharedEngine() {
        if (sharedEngine || typeof THREE === 'undefined') return sharedEngine;

        try {
            const firstPath = buildAndBakeCrumplePath(7);
            bakedPaths.push(firstPath);

            const stage = document.createElement('div');
            stage.style.position = 'fixed';
            stage.style.left = '0px';
            stage.style.top = '0px';
            stage.style.width = '1px';
            stage.style.height = '1px';
            stage.style.pointerEvents = 'none';
            stage.style.zIndex = '9999';
            stage.style.visibility = 'hidden';

            const canvas = document.createElement('canvas');
            canvas.style.width = '100%';
            canvas.style.height = '100%';
            canvas.style.display = 'block';
            canvas.style.filter = 'drop-shadow(0 12px 18px rgba(0, 0, 0, 0.42))';
            stage.appendChild(canvas);
            document.body.appendChild(stage);

            const renderer = new THREE.WebGLRenderer({
                canvas,
                alpha: true,
                antialias: true,
                powerPreference: 'high-performance'
            });
            renderer.setClearColor(0x000000, 0);
            if ('outputColorSpace' in renderer && THREE.SRGBColorSpace) {
                renderer.outputColorSpace = THREE.SRGBColorSpace;
            } else if ('outputEncoding' in renderer && THREE.sRGBEncoding) {
                renderer.outputEncoding = THREE.sRGBEncoding;
            }

            const renderPositions = new Float32Array(firstPath.vertexCount * 3);
            const renderNormals = new Float32Array(firstPath.vertexCount * 3);
            const renderUvs = new Float32Array(firstPath.vertexCount * 2);
            renderPositions.set(firstPath.bakedFrames[0].rPos);
            renderNormals.set(firstPath.bakedFrames[0].rNorm);
            renderUvs.set(firstPath.renderUvs);

            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(renderPositions, 3).setUsage(THREE.DynamicDrawUsage));
            geometry.setAttribute('normal', new THREE.BufferAttribute(renderNormals, 3).setUsage(THREE.DynamicDrawUsage));
            geometry.setAttribute('uv', new THREE.BufferAttribute(renderUvs, 2).setUsage(THREE.DynamicDrawUsage));

            // Paper grain bump texture
            const rng = randomSource(19);
            const grainData = new Uint8Array(64 * 64 * 4);
            for (let i = 0; i < grainData.length; i += 4) {
                const value = 110 + Math.floor(rng() * 145);
                grainData[i] = grainData[i + 1] = grainData[i + 2] = value;
                grainData[i + 3] = 255;
            }
            const grain = new THREE.DataTexture(grainData, 64, 64, THREE.RGBAFormat);
            grain.wrapS = grain.wrapT = THREE.RepeatWrapping;
            grain.repeat.set(5, 5 * ASPECT);
            grain.needsUpdate = true;

            const slipCanvas = document.createElement('canvas');
            slipCanvas.width = 768;
            slipCanvas.height = 160;
            const frontTexture = new THREE.CanvasTexture(slipCanvas);
            if ('colorSpace' in frontTexture && THREE.SRGBColorSpace) {
                frontTexture.colorSpace = THREE.SRGBColorSpace;
            } else if ('encoding' in frontTexture && THREE.sRGBEncoding) {
                frontTexture.encoding = THREE.sRGBEncoding;
            }

            const frontMaterial = new THREE.MeshStandardMaterial({
                roughness: 0.9,
                metalness: 0.02,
                bumpMap: grain,
                bumpScale: 0.028,
                map: frontTexture,
                transparent: true,
                opacity: 1,
                side: THREE.FrontSide
            });
            const backMaterial = new THREE.MeshStandardMaterial({
                roughness: 0.9,
                metalness: 0.02,
                bumpMap: grain,
                bumpScale: 0.028,
                color: new THREE.Color('#e5dec9'),
                transparent: true,
                opacity: 1,
                side: THREE.BackSide
            });

            const sheet = new THREE.Group();
            const front = new THREE.Mesh(geometry, frontMaterial);
            const back = new THREE.Mesh(geometry, backMaterial);
            sheet.add(front, back);

            const scene = new THREE.Scene();
            scene.add(sheet);

            const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
            const ambient = new THREE.HemisphereLight(0xfffaf0, 0x7a7062, 1.3);
            scene.add(ambient);

            const light = new THREE.DirectionalLight(0xfff5e4, 1.65);
            scene.add(light);

            // Warm-up shader compilation right now so first click has 0ms shader stall
            renderer.setSize(64, 64, false);
            renderer.render(scene, camera);

            sharedEngine = {
                stage,
                canvas,
                renderer,
                scene,
                camera,
                light,
                sheet,
                geometry,
                renderPositions,
                renderNormals,
                renderUvs,
                frontMaterial,
                backMaterial,
                frontTexture,
                slipCanvas,
                activeRaf: 0
            };

            // Pre-bake 2 more seed variations during idle time
            setTimeout(() => {
                bakedPaths.push(buildAndBakeCrumplePath(23));
                bakedPaths.push(buildAndBakeCrumplePath(41));
            }, 120);
        } catch (e) {
            sharedEngine = null;
        }

        return sharedEngine;
    }

    // Paint the cart item onto the fixed-size reusable 2D canvas (avoids GPU texture reallocation)
    function paintSlipTexture(canvas, itemData) {
        const width = 384;
        const height = 80;
        const ctx = canvas.getContext('2d');
        ctx.save();
        ctx.setTransform(2, 0, 0, 2, 0, 0);

        ctx.fillStyle = '#f4f1ea';
        ctx.fillRect(0, 0, width, height);

        ctx.fillStyle = 'rgba(0, 0, 0, 0.035)';
        for (let y = 0; y < height; y += 3) {
            ctx.fillRect(0, y, width, 1);
        }
        ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
        for (let x = 0; x < width; x += 28) {
            ctx.fillRect(x, 0, 1, height);
        }

        ctx.strokeStyle = 'rgba(18, 18, 18, 0.2)';
        ctx.lineWidth = 1;
        ctx.strokeRect(0.5, 0.5, width - 1, height - 1);

        ctx.fillStyle = '#121212';
        ctx.font = 'bold 14px Cinzel, serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(itemData?.name || 'Removed Elixir', 14, height * 0.38);

        ctx.fillStyle = 'rgba(18, 18, 18, 0.65)';
        ctx.font = 'italic 12px "Playfair Display", serif';
        const sub = itemData ? `${itemData.volume}  •  $${itemData.price.toFixed(2)} each` : '';
        ctx.fillText(sub, 14, height * 0.68);

        const boxW = 68;
        const boxH = 26;
        const boxX = width - boxW - 38;
        const boxY = (height - boxH) / 2;
        ctx.fillStyle = '#e5dec9';
        ctx.fillRect(boxX, boxY, boxW, boxH);
        ctx.strokeStyle = 'rgba(18, 18, 18, 0.25)';
        ctx.strokeRect(boxX, boxY, boxW, boxH);

        ctx.fillStyle = '#121212';
        ctx.font = 'bold 12px Cinzel, serif';
        ctx.textAlign = 'center';
        ctx.fillText(`×${itemData?.quantity || 1}`, boxX + boxW / 2, height / 2);

        ctx.strokeStyle = 'rgba(124, 29, 29, 0.45)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(10, height * 0.5);
        ctx.lineTo(width - 10, height * 0.5);
        ctx.stroke();
        ctx.restore();
    }

    function crumpleAndFall(rowElement, itemData, onComplete) {
        if (!window.ENABLE_PAPER_CRUMPLE || typeof THREE === 'undefined' || !rowElement) {
            onComplete();
            return;
        }

        const engine = ensureSharedEngine();
        if (!engine) {
            onComplete();
            return;
        }

        if (engine.activeRaf) {
            cancelAnimationFrame(engine.activeRaf);
            engine.activeRaf = 0;
        }

        const rect = rowElement.getBoundingClientRect();
        const paperWidth = Math.max(240, Math.round(rect.width));
        const paperHeight = Math.max(64, Math.round(rect.height));

        const dropDistance = 360;
        const stagePadX = 50;
        const stagePadTop = 36;
        const viewportWidth = paperWidth + stagePadX * 2;
        const viewportHeight = paperHeight + stagePadTop + dropDistance;

        // Smoothly collapse the DOM row immediately
        rowElement.style.pointerEvents = 'none';
        rowElement.style.opacity = '0';
        rowElement.style.height = `${paperHeight}px`;
        rowElement.style.overflow = 'hidden';
        rowElement.style.transition = 'height 0.34s cubic-bezier(0.22, 1, 0.36, 1), padding 0.34s cubic-bezier(0.22, 1, 0.36, 1), border 0.34s ease';
        requestAnimationFrame(() => {
            rowElement.style.height = '0px';
            rowElement.style.paddingTop = '0px';
            rowElement.style.paddingBottom = '0px';
            rowElement.style.borderWidth = '0px';
        });

        // Position pre-warmed stage over the row
        const { stage, canvas, renderer, scene, camera, light, sheet, geometry, renderPositions, renderNormals, renderUvs, frontMaterial, backMaterial, frontTexture, slipCanvas } = engine;
        stage.style.left = `${rect.left - stagePadX}px`;
        stage.style.top = `${rect.top - stagePadTop}px`;
        stage.style.width = `${viewportWidth}px`;
        stage.style.height = `${viewportHeight}px`;
        stage.style.visibility = 'visible';
        canvas.style.opacity = '1';

        paintSlipTexture(slipCanvas, itemData);
        frontTexture.needsUpdate = true;
        frontMaterial.opacity = 1;
        backMaterial.opacity = 1;

        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(viewportWidth, viewportHeight, false);

        camera.aspect = viewportWidth / viewportHeight;
        camera.position.z = viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
        camera.updateProjectionMatrix();

        const reach = Math.max(viewportWidth, viewportHeight);
        const angle = THREE.MathUtils.degToRad(-35);
        light.position.set(Math.sin(angle) * reach, Math.cos(angle) * reach, reach * 3);

        const rawId = itemData?.id;
        const numericSeed =
            typeof rawId === 'number' && Number.isFinite(rawId)
                ? Math.abs(Math.trunc(rawId))
                : String(rawId || '0')
                      .split('')
                      .reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
        const path = bakedPaths[numericSeed % bakedPaths.length] || bakedPaths[0];
        renderUvs.set(path.renderUvs);
        geometry.attributes.uv.needsUpdate = true;

        sheet.scale.setScalar(paperWidth);
        const initialY = (viewportHeight / 2) - stagePadTop - (paperHeight / 2);
        let posY = initialY;
        let posX = 0;
        sheet.position.set(0, posY, 0);
        sheet.rotation.set(0, 0, 0);

        const amount = spring(0);
        amount.target = 0.96;

        let velocityY = 35; // gentle upward recoil while crumpling, then continuous gravity pull
        let velocityX = ((Math.random() - 0.5) * 70);
        let rotVelX = (Math.random() * 4.2 + 2.5) * (Math.random() > 0.5 ? 1 : -1);
        let rotVelY = (Math.random() * 4.2 + 2.5) * (Math.random() > 0.5 ? 1 : -1);
        let rotVelZ = (Math.random() - 0.5) * 4.0;

        let elapsed = 0;
        let lastTime = performance.now();

        function interpolatePrebakedFrame(foldValue) {
            const frames = path.bakedFrames;
            const f = clamp(foldValue, 0, 1) * (frames.length - 1);
            const lo = Math.floor(f);
            const hi = Math.min(lo + 1, frames.length - 1);
            const mix = f - lo;
            const f0 = frames[lo];
            const f1 = frames[hi];
            const p0 = f0.rPos,
                p1 = f1.rPos,
                n0 = f0.rNorm,
                n1 = f1.rNorm;

            for (let i = 0, len = renderPositions.length; i < len; i++) {
                renderPositions[i] = p0[i] + (p1[i] - p0[i]) * mix;
                renderNormals[i] = n0[i] + (n1[i] - n0[i]) * mix;
            }
            geometry.attributes.position.needsUpdate = true;
            geometry.attributes.normal.needsUpdate = true;
        }

        interpolatePrebakedFrame(0);
        renderer.render(scene, camera);

        function animate(now) {
            const dt = Math.min(0.033, Math.max(0.001, (now - lastTime) / 1000));
            lastTime = now;
            elapsed += dt;

            // Smooth spring crumple
            advance(amount, dt, 0.28);
            interpolatePrebakedFrame(amount.value);

            // Continuous gravity & 3D rotation from the very start (no hang or pause!)
            const gravity = 1350;
            velocityY -= gravity * dt;
            posY += velocityY * dt;
            posX += velocityX * dt;

            sheet.position.set(posX, posY, 0);
            sheet.rotation.x += rotVelX * dt;
            sheet.rotation.y += rotVelY * dt;
            sheet.rotation.z += rotVelZ * dt;

            // Smooth fade-out as it falls past the drawer
            if (elapsed > 0.42) {
                const fade = clamp(1 - (elapsed - 0.42) / 0.26, 0, 1);
                frontMaterial.opacity = fade;
                backMaterial.opacity = fade;
                canvas.style.opacity = String(fade);
            }

            renderer.render(scene, camera);

            if (elapsed < 0.68) {
                engine.activeRaf = requestAnimationFrame(animate);
            } else {
                engine.activeRaf = 0;
                stage.style.visibility = 'hidden';
                onComplete();
            }
        }

        engine.activeRaf = requestAnimationFrame(animate);
    }

    // Pre-warm WebGL context and bake paths as soon as the page is ready
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(ensureSharedEngine, 60);
    } else {
        window.addEventListener('DOMContentLoaded', () => setTimeout(ensureSharedEngine, 60));
    }

    window.PaperCrumpleEffect = {
        crumpleAndFall
    };
})();
