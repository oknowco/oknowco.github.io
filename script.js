(() => {
  const canvas = document.querySelector('.crt-canvas');
  const msg = document.querySelector('.msg');
  const gl = canvas.getContext('webgl', { premultipliedAlpha: false, antialias: true });
  const STARTUP_DURATION_MS = 6000;

  if (!gl) {
    // No WebGL — leave the DOM fallback visible.
    window.setTimeout(function () {
      document.body.classList.remove('startup-screen');
      window.setTimeout(function () {
        document.body.classList.remove('island-pending');
        document.body.classList.add('startup-complete');
      }, 1000);
    }, STARTUP_DURATION_MS);
    return;
  }

  document.body.classList.remove('fallback-active');

  // --- Shaders ---
  const VERT_SRC = `
    attribute vec2 a_position;
    varying vec2 v_uv;
    void main() {
      v_uv = a_position * 0.5 + 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;

  // Barrel distortion: push UVs outward as a function of squared distance
  // from center. Areas that fall outside [0,1] after distortion render as
  // pure black, which reads as the curve of the tube cropping the image.
  // Scanlines are applied in distorted UV space so they bow with the curve.
  const FRAG_SRC = `
    precision highp float;
    varying vec2 v_uv;
    uniform sampler2D u_texture;
    uniform vec2 u_resolution;
    uniform float u_curvature;
    uniform float u_scanlineStrength;
    uniform float u_aberration;
    uniform float u_bloomIntensity;
    uniform float u_maskIntensity;
    uniform float u_tintIntensity;
    uniform float u_vignette;
    uniform float u_bezel;
    uniform float u_brightness;
    uniform float u_grainIntensity;
    uniform float u_dpr;

    float hash(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    // Phosphor bloom — 5x5 Gaussian-weighted bright-pass blur, sampled
    // around the current UV. Only pixels above a brightness threshold
    // contribute, so dark areas stay dark and bright text/lit phosphor
    // bleeds soft light into its surroundings.
    vec3 computeBloom(vec2 uv) {
      vec3 sum = vec3(0.0);
      float totalWeight = 0.0;
      float r = 3.0 / u_resolution.x;
      for (int x = -2; x <= 2; x++) {
        for (int y = -2; y <= 2; y++) {
          vec2 offset = vec2(float(x), float(y)) * r * 3.0;
          vec3 s = texture2D(u_texture, uv + offset).rgb;
          s = max(s - 0.3, 0.0);
          float w = exp(-0.5 * float(x * x + y * y));
          sum += s * w;
          totalWeight += w;
        }
      }
      return sum / totalWeight;
    }

    void main() {
      vec2 uv = v_uv;
      vec2 c = uv - 0.5;
      float r2 = dot(c, c);
      uv = uv + c * r2 * u_curvature;

      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }

      // Chromatic aberration — RGB channels offset radially from center.
      vec2 dir = uv - 0.5;
      vec4 color;
      color.r = texture2D(u_texture, uv - dir * u_aberration).r;
      color.g = texture2D(u_texture, uv).g;
      color.b = texture2D(u_texture, uv + dir * u_aberration).b;
      color.a = 1.0;

      // Bloom — add soft glow from bright pixels
      color.rgb += computeBloom(uv) * u_bloomIntensity;

      // Aperture-grille mask — Trinitron-style RGB column stripes.
      // Each output pixel column emphasises one channel and slightly
      // dims the other two, creating the subpixel structure.
      float px = uv.x * u_resolution.x;
      float sub = mod(px, 3.0);
      vec3 mask = vec3(1.0);
      if (sub < 1.0)      mask = vec3(1.0 + u_maskIntensity, 1.0 - u_maskIntensity * 0.5, 1.0 - u_maskIntensity * 0.5);
      else if (sub < 2.0) mask = vec3(1.0 - u_maskIntensity * 0.5, 1.0 + u_maskIntensity, 1.0 - u_maskIntensity * 0.5);
      else                mask = vec3(1.0 - u_maskIntensity * 0.5, 1.0 - u_maskIntensity * 0.5, 1.0 + u_maskIntensity);
      color.rgb *= mask;

      // Off-pixel tint — faint cool cast on unlit areas so dark pixels
      // don't read as pure neutral grey. Brighter pixels keep their hue.
      float luma = dot(color.rgb, vec3(0.299, 0.587, 0.114));
      color.rgb += vec3(0.01, 0.025, 0.04) * u_tintIntensity * (1.0 - luma);

      // Scanlines in distorted UV space — sine modulation keeps the
      // dark bands softer than a hard step while still bowing with the tube.
      float pixelY = uv.y * u_resolution.y;
      float scan = sin(pixelY * 3.14159265 * 2.0 / 3.0);
      float scanIntensity = pow(((0.5 * scan) + 0.5) * 0.9 + 0.1, u_scanlineStrength);
      color.rgb *= scanIntensity;

      // Static phosphor/grime variation. This is intentionally tied to
      // fragment position, not time, so the screen has texture without
      // the unrealistic crawling noise of a video filter.
      vec2 grainCell = floor(gl_FragCoord.xy / max(1.0, u_dpr));
      float grain = hash(grainCell) - 0.5;
      color.rgb += grain * u_grainIntensity * (0.58 + luma * 0.42);

      // Tube vignette — soft curved-glass phosphor falloff in DISTORTED
      // UV space, so it follows the bulge of the image. Centre offset
      // slightly to the lower-right to match the original asymmetric look.
      vec2 vc = uv - vec2(0.55, 0.6);
      float vd = length(vc);
      float vig = smoothstep(0.35, 0.75, vd);
      color.rgb *= 1.0 - vig * u_vignette;

      // Bezel cast-shadow — uses PRE-DISTORT UV (v_uv) so the shadow
      // stays rectilinear relative to the viewport, like a flat bezel
      // sitting in front of the curved glass would. Sizes are in CSS
      // pixels (device pixels / DPR) so the shadow keeps the same
      // absolute thickness when the viewport is resized. Clamped to
      // 35% of viewport so very small screens don't get swamped.
      vec2 sizePx = u_resolution / u_dpr;
      vec2 pxPos = v_uv * sizePx;
      float topSize    = min(220.0, sizePx.y * 0.35);
      float leftSize   = min(180.0, sizePx.x * 0.35);
      float bottomSize = min(140.0, sizePx.y * 0.28);
      float rightSize  = min(140.0, sizePx.x * 0.28);
      float top    = smoothstep(topSize,    0.0, pxPos.y);
      float left   = smoothstep(leftSize,   0.0, pxPos.x);
      float bottom = smoothstep(bottomSize, 0.0, sizePx.y - pxPos.y);
      float rightS = smoothstep(rightSize,  0.0, sizePx.x - pxPos.x);
      float shadow = top * 0.95 + left * 0.85 + bottom * 0.55 + rightS * 0.50;
      shadow = min(shadow, 0.95) * u_bezel;
      color.rgb *= 1.0 - shadow;
      color.rgb *= u_brightness;

      gl_FragColor = color;
    }
  `;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error('Shader compile error:', gl.getShaderInfoLog(s));
      gl.deleteShader(s);
      return null;
    }
    return s;
  }

  const vs = compile(gl.VERTEX_SHADER, VERT_SRC);
  const fs = compile(gl.FRAGMENT_SHADER, FRAG_SRC);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('Program link error:', gl.getProgramInfoLog(program));
    document.body.classList.add('fallback-active');
    return;
  }

  // Full-screen quad (two triangles in clip space)
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,  1, -1, -1,  1,
    -1,  1,  1, -1,  1,  1,
  ]), gl.STATIC_DRAW);

  const aPosition         = gl.getAttribLocation(program, 'a_position');
  const uTexture          = gl.getUniformLocation(program, 'u_texture');
  const uRes              = gl.getUniformLocation(program, 'u_resolution');
  const uCurvature        = gl.getUniformLocation(program, 'u_curvature');
  const uScanlineStrength = gl.getUniformLocation(program, 'u_scanlineStrength');
  const uAberration       = gl.getUniformLocation(program, 'u_aberration');
  const uBloomIntensity   = gl.getUniformLocation(program, 'u_bloomIntensity');
  const uMaskIntensity    = gl.getUniformLocation(program, 'u_maskIntensity');
  const uTintIntensity    = gl.getUniformLocation(program, 'u_tintIntensity');
  const uVignette         = gl.getUniformLocation(program, 'u_vignette');
  const uBezel            = gl.getUniformLocation(program, 'u_bezel');
  const uBrightness       = gl.getUniformLocation(program, 'u_brightness');
  const uGrainIntensity   = gl.getUniformLocation(program, 'u_grainIntensity');
  const uDpr              = gl.getUniformLocation(program, 'u_dpr');

  const FX = {
    curvature: 0.1,
    scanlineStrength: 0.35,
    aberration: 0.007,
    bloomIntensity: 1.08,
    maskIntensity: 0.4,
    tintIntensity: 0,
    vignette: 0.15,
    bezel: 0.46,
    brightness: 1.08,
    grainIntensity: 0.018
  };

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // 2D canvas where we pre-render the screen content (background + text).
  // Re-rendered on resize and uploaded to GL as a texture.
  const tc = document.createElement('canvas');
  const ctx = tc.getContext('2d');
  let textureW = 0;
  let textureH = 0;
  let startupActive = false;
  const startupImage = new Image();
  let startupImageReady = false;
  let startupRaf = 0;
  let startupTimer = 0;
  let islandTimer = 0;
  let startupStartedAt = Date.now();

  function invalidateTexture() {
    textureW = 0;
    textureH = 0;
    render();
  }

  function stopStartupFrame() {
    if (startupRaf) cancelAnimationFrame(startupRaf);
    startupRaf = 0;
  }

  function finishStartupSequence() {
    startupActive = false;
    stopStartupFrame();
    document.body.classList.remove('startup-screen');
    document.body.classList.remove('crt-powering-on');
    invalidateTexture();
    islandTimer = window.setTimeout(function () {
      document.body.classList.remove('island-pending');
      document.body.classList.add('startup-complete');
      islandTimer = 0;
    }, 1000);
  }

  function startStartupSequence() {
    window.clearTimeout(startupTimer);
    window.clearTimeout(islandTimer);
    stopStartupFrame();

    startupStartedAt = Date.now();
    startupActive = true;
    document.body.classList.remove(
      'powered-off',
      'ui-powered-off',
      'crt-shutting-down',
      'startup-complete'
    );
    document.body.classList.remove('crt-powering-on');
    document.body.classList.add('startup-screen', 'island-pending');
    invalidateTexture();

    startupRaf = requestAnimationFrame(tickStartup);
    startupTimer = window.setTimeout(function () {
      startupTimer = 0;
      finishStartupSequence();
    }, STARTUP_DURATION_MS);
  }

  startupImage.onload = function () {
    startupImageReady = true;
    if (startupActive) invalidateTexture();
  };
  startupImage.decoding = 'async';
  startupImage.fetchPriority = 'high';
  startupImage.src = 'assets/clouds.jpg';

  function tickStartup() {
    if (!startupActive) return;
    textureW = 0;
    textureH = 0;
    render();
    startupRaf = requestAnimationFrame(tickStartup);
  }

  function drawCoverImage(image, w, h) {
    var scale = Math.max(w / image.naturalWidth, h / image.naturalHeight);
    var dw = image.naturalWidth * scale;
    var dh = image.naturalHeight * scale;
    ctx.drawImage(image, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }

  function drawStartupActivityBar(w, h, dpr) {
    var barHeight = Math.max(13 * dpr, h * 0.02);
    var y = h - barHeight;
    var columnW = Math.max(36 * dpr, Math.round(w * 0.055));
    var palette = [
      '#c9d7d8',
      '#b5cbcf',
      '#a0bdc9',
      '#8aacc2',
      '#739cbb',
      '#5d8db4',
      '#4e80ad',
      '#4476a8',
      '#3f70a4',
      '#4d7ca9',
      '#638caf',
      '#7aa0b7',
      '#95b4c2',
      '#b1c8cc'
    ];
    var elapsed = (Date.now() - startupStartedAt) / 1000;
    var patternWidth = columnW * palette.length;
    var offset = -((elapsed * columnW * 1.45) % patternWidth);
    var featherHeight = Math.max(3 * dpr, Math.round(barHeight * 0.38));

    var feather = ctx.createLinearGradient(0, y - featherHeight, 0, y);
    feather.addColorStop(0, 'rgba(143, 178, 192, 0)');
    feather.addColorStop(1, 'rgba(143, 178, 192, 0.82)');
    ctx.fillStyle = feather;
    ctx.fillRect(0, y - featherHeight, w, featherHeight);
    ctx.fillStyle = '#8fb2c0';
    ctx.fillRect(0, y, w, barHeight);

    for (var x = offset - patternWidth; x < w + columnW; x += columnW) {
      var rawIndex = Math.floor((x - offset) / columnW);
      var index = ((rawIndex % palette.length) + palette.length) % palette.length;
      ctx.fillStyle = palette[index];
      ctx.fillRect(x, y, columnW + 1, barHeight);
    }

    ctx.fillStyle = 'rgba(58, 104, 146, 0.28)';
    ctx.fillRect(0, h - Math.max(1, Math.round(dpr)), w, Math.max(1, Math.round(dpr)));
  }

  function drawStartupScreen(w, h) {
    if (startupImageReady) {
      drawCoverImage(startupImage, w, h);
    } else {
      ctx.fillStyle = '#77b7e7';
      ctx.fillRect(0, 0, w, h);
    }

    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.fillRect(0, 0, w, h);

    var dpr = window.devicePixelRatio || 1;
    var cssWidth = w / dpr;
    var isMobile = cssWidth < 640;
    var lines = isMobile
      ? ['Please wait while', 'the present is noticed.']
      : ['Please wait while the present', 'is noticed.'];
    var cssFontPx = isMobile
      ? Math.min(72, Math.max(32, cssWidth * 0.075))
      : Math.min(96, Math.max(25.6, cssWidth * 0.05));
    var fontPx = cssFontPx * dpr;

    ctx.font = `700 ${fontPx}px "MS Sans Serif", "Microsoft Sans Serif", Tahoma, Geneva, Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e69142';
    ctx.shadowColor = 'rgba(255, 255, 255, 0.38)';
    ctx.shadowBlur = Math.max(1, 2 * dpr);

    var maxTextWidth = w * 0.78;
    while (Math.max(...lines.map((line) => ctx.measureText(line).width)) > maxTextWidth && cssFontPx > 20) {
      cssFontPx -= 1;
      fontPx = cssFontPx * dpr;
      ctx.font = `700 ${fontPx}px "MS Sans Serif", "Microsoft Sans Serif", Tahoma, Geneva, Arial, sans-serif`;
    }

    var lh = fontPx * 1.16;
    var startY = h / 2 - ((lines.length - 1) * lh) / 2;
    for (var i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], w / 2, startY + i * lh);
    }
    ctx.shadowBlur = 0;
    drawStartupActivityBar(w, h, dpr);
  }

  function renderTexture(w, h) {
    tc.width = w;
    tc.height = h;

    if (startupActive) {
      drawStartupScreen(w, h);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tc);
      return;
    }

    // Screen base colour
    ctx.fillStyle = '#2e3338';
    ctx.fillRect(0, 0, w, h);

    // Text
    const isMobile = w < 640 * (window.devicePixelRatio || 1);
    // Match the CSS clamp(...) — px values, not rem, because the
    // canvas is sized in device pixels. Mobile uses larger text
    // because its three short lines have room to breathe.
    const cssWidth = w / (window.devicePixelRatio || 1);
    const lines = isMobile
      ? ["It's OK now", "to turn off", "your device"]
      : ["It's OK now to turn off", "your computer."];
    let cssFontPx = isMobile
      ? Math.min(72, Math.max(32, cssWidth * 0.075))
      : Math.min(96, Math.max(25.6, cssWidth * 0.05));
    let fontPx = cssFontPx * (window.devicePixelRatio || 1);

    ctx.fillStyle = '#dca67c';
    ctx.font = `700 ${fontPx}px "MS Sans Serif", "Microsoft Sans Serif", Tahoma, Geneva, Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const maxTextWidth = w * 0.82;
    while (Math.max(...lines.map((line) => ctx.measureText(line).width)) > maxTextWidth && cssFontPx > 24) {
      cssFontPx -= 1;
      fontPx = cssFontPx * (window.devicePixelRatio || 1);
      ctx.font = `700 ${fontPx}px "MS Sans Serif", "Microsoft Sans Serif", Tahoma, Geneva, Arial, sans-serif`;
    }

    const lh = fontPx * 1.2;
    const startY = h / 2 - ((lines.length - 1) * lh) / 2;
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], w / 2, startY + i * lh);
    }

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tc);
  }

  function render() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width  * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));

    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    if (textureW !== w || textureH !== h) {
      renderTexture(w, h);
      textureW = w;
      textureH = h;
    }

    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const cssWidth = w / dpr;
    const mobileCrt = cssWidth < 640;
    const bloomIntensity = mobileCrt ? 0.62 : FX.bloomIntensity;
    const aberration = mobileCrt ? 0.0036 : FX.aberration;
    const maskIntensity = mobileCrt ? 0.3 : FX.maskIntensity;
    const grainIntensity = mobileCrt ? 0.012 : FX.grainIntensity;

    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(uTexture, 0);
    gl.uniform2f(uRes, w, h);
    gl.uniform1f(uCurvature, FX.curvature);
    gl.uniform1f(uScanlineStrength, FX.scanlineStrength);
    gl.uniform1f(uAberration, aberration);
    gl.uniform1f(uBloomIntensity, bloomIntensity);
    gl.uniform1f(uMaskIntensity, maskIntensity);
    gl.uniform1f(uTintIntensity, FX.tintIntensity);
    gl.uniform1f(uVignette, FX.vignette);
    gl.uniform1f(uBezel, FX.bezel);
    gl.uniform1f(uBrightness, FX.brightness);
    gl.uniform1f(uGrainIntensity, grainIntensity);
    gl.uniform1f(uDpr, dpr);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  startStartupSequence();

  function addPressFeedback(button) {
    if (!button) return;
    let pressTimer = 0;
    function setPressed() {
      window.clearTimeout(pressTimer);
      button.classList.add('is-pressed');
    }
    function releasePressed() {
      window.clearTimeout(pressTimer);
      pressTimer = window.setTimeout(function () {
        button.classList.remove('is-pressed');
      }, 120);
    }
    button.addEventListener('pointerdown', setPressed);
    button.addEventListener('pointerup', releasePressed);
    button.addEventListener('pointerleave', releasePressed);
    button.addEventListener('pointercancel', releasePressed);
    button.addEventListener('blur', function () {
      window.clearTimeout(pressTimer);
      button.classList.remove('is-pressed');
    });
  }

  let resizeRaf = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(render);
  });

  // Monitor power button — toggles the powered-off state on body.
  const powerBtn = document.getElementById('power-btn');
  if (powerBtn) {
    addPressFeedback(powerBtn);
    powerBtn.addEventListener('click', function () {
      togglePower();
    });
  }

  let powerAnimating = false;
  let audioCtx = null;
  const clickAudio = new Audio('assets/monitor-click.wav');
  clickAudio.preload = 'auto';

  function getAudioCtx() {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function blip(freq, start, duration, gainValue, type) {
    var ctx = getAudioCtx();
    if (!ctx) return;
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(gainValue, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  function playClickSample(volume) {
    try {
      var click = clickAudio.cloneNode();
      click.volume = typeof volume === 'number' ? volume : 0.85;
      click.play().catch(function () {});
    } catch (error) {}
  }

  function playPowerSound(turningOn) {
    playClickSample();
    var ctx = getAudioCtx();
    if (!ctx) return;
    var now = ctx.currentTime;
    if (turningOn) {
      blip(92, now + 0.06, 0.18, 0.014, 'sine');
      blip(138, now + 0.17, 0.22, 0.01, 'sine');
    } else {
      blip(118, now + 0.06, 0.12, 0.014, 'sawtooth');
      blip(48, now + 0.17, 0.22, 0.01, 'sine');
    }
  }

  function togglePower() {
    if (startupActive || powerAnimating) return;
    powerAnimating = true;
    var turningOn = document.body.classList.contains('powered-off');
    playPowerSound(turningOn);

    if (turningOn) {
      startStartupSequence();
      void canvas.offsetWidth;
      document.body.classList.add('crt-powering-on');
      window.setTimeout(function () {
        powerAnimating = false;
      }, 940);
    } else {
      document.body.classList.add('ui-powered-off');
      document.body.classList.add('crt-shutting-down');
      window.setTimeout(function () {
        document.body.classList.add('powered-off');
        document.body.classList.remove('crt-shutting-down');
        powerAnimating = false;
      }, 280);
    }
  }

  function setGlare(x, y) {
    document.body.style.setProperty('--glare-x', (34 + x * 18).toFixed(2) + '%');
    document.body.style.setProperty('--glare-y', (18 + y * 12).toFixed(2) + '%');
  }

  window.addEventListener('deviceorientation', function (event) {
    var gamma = Math.max(-30, Math.min(30, event.gamma || 0)) / 30;
    var beta = Math.max(-30, Math.min(30, (event.beta || 0) - 45)) / 30;
    setGlare(gamma, beta);
  });
})();
