"use client";

import { useLayoutEffect, useRef } from "react";

/**
 * 液态导航（React 版）。
 *
 * 行为对齐 docs/prototypes/navbar-centered/index.html 与
 * docs/prototypes/dashboard-welcome/index.html 的 Liquid glass 草稿：
 *   · 水面 / 液滴拉伸与分裂 / 点击涟漪 / 鼠标弯月面；
 *   · 静止 HOLD_MS 后停 rAF，不在页面后台持续烧 GPU；
 *   · prefers-reduced-motion 直接退回 CSS 液滴，不创建 WebGL；
 *   · WebGL 不可用（或 context lost）也退回 CSS 液滴，不崩。
 *
 * 尺寸 / 定位的 CSS 由调用方传入（水面画布的类与 CSS 液滴的类都在
 * CenteredNavbar.module.css 里）；本组件只负责把画布画在正确的位置。
 *
 * 颜色属于 WebGL shader 内部常量（GLSL 读不到 CSS var()），是深色主题
 * --brand / --card 玻璃折射的近似值；主题切换由 uDark uniform 在运行时补光。
 */
export interface LiquidNavbarProps {
  /** 当前液态目标变化时触发一次重新测量（例如切换激活项 / 打开“更多”）。 */
  activeKey: string;
  /** 水面 canvas 的类名（由调用方的 CSS Module 提供）。 */
  canvasClassName: string;
  /** CSS 液滴的类名（由调用方的 CSS Module 提供）。 */
  dropClassName: string;
}

/** 水面画布向药丸四周留出的出血，单位 px（与草稿的 PAD 一致）。 */
const PAD = 14;

/**
 * 静止多久后停 rAF。这是原型确认的**行为阈值**（900ms），不是视觉动效时长，
 * 因此不映射 --motion-*；视觉过渡仍全部走 CSS 语义令牌。
 */
const IDLE_HOLD_MS = 900;

const VERTEX_SHADER = `
attribute vec2 a;
void main() {
  gl_Position = vec4(a, 0., 1.);
}
`;

/*
 * shader 内的颜色量是 GLSL 常量，读不到 CSS var()：它们只是深色主题
 * --brand / --card 玻璃折射的近似值，浅色由 uDark uniform 在运行时补光。
 * 页面上的颜色与过渡时长一律走 CSS 语义令牌（见 CenteredNavbar.module.css）。
 */
const FRAGMENT_SHADER = `
precision highp float;
uniform vec2 uRes;
uniform float uDpr;
uniform float uTime;
uniform vec4 uPill;
uniform vec4 uBlob[6];
uniform float uSy[6];
uniform vec4 uRip[6];
uniform vec3 uMouse;
uniform float uDark;

float sdRB(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.)) + min(max(q.x, q.y), 0.) - r;
}

float sdCap(vec2 p, vec4 B, float sy) {
  p -= B.xy;
  p.y /= sy;
  p.x = max(abs(p.x) - B.z, 0.);
  return (length(p) - B.w) * min(1., sy);
}

float smin(float a, float b, float k) {
  float h = clamp(.5 + .5 * (b - a) / k, 0., 1.);
  return mix(b, a, h) - k * h * (1. - h);
}

float dropD(vec2 p) {
  float d = 1e4;
  for (int i = 0; i < 6; i++) {
    if (uBlob[i].w > .5) {
      d = smin(d, sdCap(p, uBlob[i], uSy[i]), 13.);
    }
  }
  return d;
}

float pillD(vec2 p) {
  vec2 h = uPill.zw * .5;
  return sdRB(p - uPill.xy - h, h, h.y);
}

float lens(float d, float w) {
  float t = clamp(-d / w, 0., 1.);
  return sqrt(1. - (1. - t) * (1. - t));
}

float waves(vec2 p) {
  float w = 0.;
  for (int i = 0; i < 6; i++) {
    vec4 R = uRip[i];
    if (R.w > 0.) {
      float x = length(p - R.xy) - R.z * 240.;
      w += R.w * exp(-R.z * 1.7) * sin(x * .3) * exp(-x * x / 700.);
    }
  }
  vec2 m = p - uMouse.xy;
  w += uMouse.z * 3.6 * exp(-dot(m, m) / 1000.);
  return w;
}

float H(vec2 p) {
  float dp = pillD(p);
  return lens(dp, uPill.w * .36) * 2.4
    + lens(dropD(p), 11.) * 7.5
    + waves(p) * smoothstep(0., 7., -dp);
}

float caus(vec2 p, float t) {
  vec2 q = p;
  float c = 0.;
  for (int i = 0; i < 3; i++) {
    q += vec2(sin(q.y * 1.1 + t), cos(q.x * 1.3 - t * .7)) * .6;
    c += 1. / (1. + 16. * abs(sin(q.x) * sin(q.y)));
  }
  return c / 3.;
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y * uDpr - gl_FragCoord.y) / uDpr;
  float dp = pillD(p);
  float dd = dropD(p);
  float h0 = H(p);
  vec3 n = normalize(vec3(h0 - H(p + vec2(1., 0.)), h0 - H(p + vec2(0., 1.)), 1.));
  vec3 V = vec3(0., 0., 1.);
  float spec = pow(max(dot(reflect(-normalize(vec3(-.45, -.8, .85)), n), V), 0.), 70.);
  float spec2 = pow(max(dot(reflect(-normalize(vec3(.6, .75, .7)), n), V), 0.), 22.) * .3;
  float fres = clamp((1. - n.z) * 4., 0., 1.);
  vec3 irid = .5 + .5 * cos(6.2831 * (vec3(0., .33, .67) + fres * .85 + p.x * .0028 + uTime * .035));
  float pm = smoothstep(1., -1., dp);
  float dm = smoothstep(1., -1., dd) * smoothstep(1., -2., dp);
  float sh = smoothstep(9., -9., dropD(p - vec2(0., 5.))) * (1. - dm) * pm * (.11 + .07 * uDark);
  vec3 c = vec3(0., .14, .36) * sh;
  float a = sh;
  float pa = clamp(pm * (fres * .5 + spec * .9 + spec2), 0., 1.);
  pa *= 1. - .5 * uDark;
  vec3 hi = mix(vec3(1.), vec3(.32, .58, .92), uDark);
  c = mix(hi, irid, .5 * fres) * pa + c * (1. - pa);
  a = pa + a * (1. - pa);
  float th = lens(dd, 11.);
  float cs = caus((p + n.xy * th * 18.) * .085, uTime * .9);
  vec3 tint = mix(vec3(.80, .95, 1.), vec3(.55, .82, 1.), uDark);
  float rim = dm * (1. - smoothstep(0., 8., -dd));
  float cres = dm * smoothstep(.12, .55, dot(n.xy, normalize(vec2(.55, .85)))) * smoothstep(0., 3., -dd);
  float body = .5 + .5 * clamp(-n.y * 3., -1., 1.);
  float da = dm * (.26 + .14 * body) * (1. - .35 * uDark) * (1. - .25 * uDark);
  vec3 dc = mix(tint, vec3(1.), body * .6);
  float la = rim * .22;
  vec3 lc = mix(vec3(0., .42, .78), vec3(.1, .55, .95), uDark);
  dc = lc * la + dc * da * (1. - la);
  da = la + da * (1. - la);
  la = clamp(cres * .7 + smoothstep(.6, 1., cs) * .28 * th * dm, 0., 1.);
  dc = hi * la + dc * (1. - la);
  da = la + da * (1. - la);
  la = clamp(dm * (spec * 1.2 + spec2 * .5), 0., 1.);
  dc = hi * la + dc * (1. - la);
  da = la + da * (1. - la);
  la = dm * smoothstep(-2., 0., dd) * .4;
  dc = mix(vec3(1.), irid, .35) * la + dc * (1. - la);
  da = la + da * (1. - la);
  c = dc + c * (1. - da);
  a = da + a * (1. - da);
  gl_FragColor = vec4(c, a);
}
`;

interface Body {
  x: number;
  v: number;
}

interface Satellite {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  k: number;
}

interface Ripple {
  x: number;
  y: number;
  age: number;
  amp: number;
}

interface EngineState {
  a: Body;
  b: Body;
  sy: { s: number; v: number };
  lead: number;
  lagFrom: number;
  sats: Satellite[];
  rips: Ripple[];
  t: { x: number; cy: number; q: number; r: number };
  q: number;
  mouse: { x: number; y: number; s: number; on: boolean };
  moving: boolean;
  split: boolean;
  ready: boolean;
  w: number;
  h: number;
  raf: number;
  last: number;
  time: number;
  holdUntil: number;
}

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export default function LiquidNavbar({
  activeKey,
  canvasClassName,
  dropClassName,
}: LiquidNavbarProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dropRef = useRef<HTMLSpanElement | null>(null);
  const measureRef = useRef<(() => void) | null>(null);

  // useLayoutEffect 在 SSR 期间不会执行；canvas / drop 先渲染成空壳，
  // 客户端首帧测量后再决定走 WebGL 还是 CSS 液滴。
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const drop = dropRef.current;
    if (!canvas || !drop) return;
    const pill = canvas.parentElement;
    if (!pill) return;

    const cleanups: Array<() => void> = [];

    const activeElement = (): HTMLElement | null =>
      pill.querySelector<HTMLElement>('[data-liquid-active="true"]')
      ?? pill.querySelector<HTMLElement>('[aria-current="page"]')
      ?? pill.querySelector<HTMLElement>("[data-nav-item]");

    /** CSS 液滴：把高亮条量到当前激活项下方（WebGL 不可用 / reduced-motion 时使用）。 */
    const placeDrop = () => {
      const element = activeElement();
      if (!element) {
        drop.style.opacity = "0";
        return;
      }
      const rect = element.getBoundingClientRect();
      const pillRect = pill.getBoundingClientRect();
      drop.style.opacity = "1";
      drop.style.left = `${rect.left - pillRect.left}px`;
      drop.style.width = `${rect.width}px`;
    };

    measureRef.current = placeDrop;
    let resizeLayout: () => void = () => {
      measureRef.current?.();
    };

    const prefersReducedMotion =
      typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const fallbackToCssDrop = () => {
      canvas.style.display = "none";
      pill.removeAttribute("data-liquid-gl");
      measureRef.current = placeDrop;
      resizeLayout = () => placeDrop();
      placeDrop();
    };

    // 布局观测与 CSS 液滴的定位与 WebGL 是否可用无关：WebGL 不可用时
    // 这仍然是唯一的定位来源。
    const onWindowResize = () => resizeLayout();
    window.addEventListener("resize", onWindowResize);
    cleanups.push(() => window.removeEventListener("resize", onWindowResize));

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver === "function") {
      resizeObserver = new ResizeObserver(() => resizeLayout());
      resizeObserver.observe(pill);
      cleanups.push(() => resizeObserver?.disconnect());
    }

    let mutationObserver: MutationObserver | null = null;
    if (typeof MutationObserver === "function") {
      mutationObserver = new MutationObserver(() => measureRef.current?.());
      mutationObserver.observe(pill, {
        attributes: true,
        subtree: true,
        attributeFilter: ["aria-current", "data-liquid-active"],
      });
      cleanups.push(() => mutationObserver?.disconnect());
    }

    if (prefersReducedMotion || typeof window.requestAnimationFrame !== "function") {
      fallbackToCssDrop();
      return () => {
        for (const cleanup of cleanups.reverse()) cleanup();
        measureRef.current = null;
      };
    }

    let gl: WebGLRenderingContext | null = null;
    try {
      gl = canvas.getContext("webgl", {
        premultipliedAlpha: true,
        alpha: true,
        antialias: false,
      });
    } catch {
      gl = null;
    }

    if (!gl) {
      fallbackToCssDrop();
      return () => {
        for (const cleanup of cleanups.reverse()) cleanup();
        measureRef.current = null;
      };
    }

    const glContext = gl;
    let program: WebGLProgram | null = null;
    const uniforms: Record<string, WebGLUniformLocation | null> = {};

    function initWebgl(): boolean {
      const vertexShader = compileShader(
        glContext,
        glContext.VERTEX_SHADER,
        VERTEX_SHADER,
      );
      const fragmentShader = compileShader(
        glContext,
        glContext.FRAGMENT_SHADER,
        FRAGMENT_SHADER,
      );
      if (!vertexShader || !fragmentShader) return false;

      const nextProgram = glContext.createProgram();
      if (!nextProgram) return false;
      glContext.attachShader(nextProgram, vertexShader);
      glContext.attachShader(nextProgram, fragmentShader);
      glContext.linkProgram(nextProgram);
      if (!glContext.getProgramParameter(nextProgram, glContext.LINK_STATUS)) {
        glContext.deleteProgram(nextProgram);
        return false;
      }

      glContext.useProgram(nextProgram);
      program = nextProgram;

      const buffer = glContext.createBuffer();
      if (!buffer) return false;
      glContext.bindBuffer(glContext.ARRAY_BUFFER, buffer);
      glContext.bufferData(
        glContext.ARRAY_BUFFER,
        new Float32Array([-1, -1, 3, -1, -1, 3]),
        glContext.STATIC_DRAW,
      );

      const position = glContext.getAttribLocation(nextProgram, "a");
      glContext.enableVertexAttribArray(position);
      glContext.vertexAttribPointer(position, 2, glContext.FLOAT, false, 0, 0);

      for (const name of [
        "uRes",
        "uDpr",
        "uTime",
        "uPill",
        "uBlob",
        "uSy",
        "uRip",
        "uMouse",
        "uDark",
      ]) {
        uniforms[name] = glContext.getUniformLocation(nextProgram, name);
      }

      return true;
    }

    if (!initWebgl()) {
      if (program) glContext.deleteProgram(program);
      fallbackToCssDrop();
      return () => {
        for (const cleanup of cleanups.reverse()) cleanup();
        measureRef.current = null;
      };
    }

    canvas.style.display = "block";
    pill.setAttribute("data-liquid-gl", "on");

    const state: EngineState = {
      a: { x: 0, v: 0 },
      b: { x: 0, v: 0 },
      sy: { s: 1, v: 0 },
      lead: 0,
      lagFrom: 0,
      sats: [],
      rips: [],
      t: { x: 0, cy: 0, q: 0, r: 21 },
      q: 0,
      mouse: { x: 0, y: 0, s: 0, on: false },
      moving: false,
      split: false,
      ready: false,
      w: 0,
      h: 0,
      raf: 0,
      last: 0,
      time: 0,
      holdUntil: 0,
    };

    const resizeCanvas = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = state.w + PAD * 2;
      const height = state.h + PAD * 2;
      if (
        canvas.width !== Math.round(width * dpr)
        || canvas.height !== Math.round(height * dpr)
      ) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }
    };

    const measure = () => {
      const element = activeElement();
      if (!element) return;

      state.w = pill.offsetWidth;
      state.h = pill.offsetHeight;

      const target = state.t;
      target.r = element.offsetHeight / 2;
      target.q = Math.max(0, element.offsetWidth / 2 - target.r);
      target.cy = PAD + element.offsetTop + element.offsetHeight / 2;
      const nextX = PAD + element.offsetLeft + element.offsetWidth / 2;

      if (!state.ready) {
        state.a.x = nextX;
        state.b.x = nextX;
        state.q = target.q;
        state.ready = true;
      } else if (Math.abs(nextX - target.x) > 0.5) {
        state.lead = Math.abs(nextX - state.a.x) <= Math.abs(nextX - state.b.x) ? 0 : 1;
        state.lagFrom = performance.now() + 70;
        state.moving = true;
        state.split = false;
      }

      target.x = nextX;
      resizeCanvas();
      wake();
    };

    const draw = () => {
      const target = state.t;
      const separation = Math.abs(state.a.x - state.b.x);
      const thin = Math.min(separation / (2 * (state.q + target.r) || 1), 1);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);

      glContext.viewport(
        0,
        0,
        glContext.drawingBufferWidth,
        glContext.drawingBufferHeight,
      );
      glContext.uniform2f(uniforms.uRes, state.w + PAD * 2, state.h + PAD * 2);
      glContext.uniform1f(uniforms.uDpr, dpr);
      glContext.uniform1f(uniforms.uTime, state.time);
      glContext.uniform4f(uniforms.uPill, PAD, PAD, state.w, state.h);

      const blobs = new Float32Array(24);
      const sy = new Float32Array(6).fill(1);
      const head = state.lead === 0 ? state.a : state.b;
      const tail = state.lead === 0 ? state.b : state.a;
      blobs.set(
        [
          head.x,
          target.cy,
          target.q * (1 - .25 * thin),
          target.r * (1 - .12 * thin),
          tail.x,
          target.cy,
          target.q * (1 - .65 * thin),
          target.r * (1 - .38 * thin),
        ],
        0,
      );
      sy[0] = state.sy.s;
      sy[1] = state.sy.s;
      state.sats.slice(0, 4).forEach((satellite, index) => {
        blobs.set([satellite.x, satellite.y, 0, satellite.r], 8 + index * 4);
      });

      glContext.uniform4fv(uniforms.uBlob, blobs);
      glContext.uniform1fv(uniforms.uSy, sy);

      const ripples = new Float32Array(24);
      state.rips.slice(-6).forEach((ripple, index) => {
        ripples.set([ripple.x, ripple.y, ripple.age, ripple.amp], index * 4);
      });
      glContext.uniform4fv(uniforms.uRip, ripples);
      glContext.uniform3f(uniforms.uMouse, state.mouse.x, state.mouse.y, state.mouse.s);
      glContext.uniform1f(
        uniforms.uDark,
        document.documentElement.dataset.theme === "light" ? 0 : 1,
      );

      glContext.clearColor(0, 0, 0, 0);
      glContext.clear(glContext.COLOR_BUFFER_BIT);
      glContext.drawArrays(glContext.TRIANGLES, 0, 3);
    };

    function wake() {
      state.holdUntil = performance.now() + IDLE_HOLD_MS;
      loop();
    }

    function step(dt: number, now: number) {
      const target = state.t;
      state.time += dt;
      state.q += (target.q - state.q) * Math.min(1, dt * 12);

      const bodies = [state.a, state.b];
      let still = true;

      bodies.forEach((body, index) => {
        const lead = index === state.lead;
        const stiffness = lead ? 210 : 72;
        const damping = lead ? 25 : 13;
        const factor = !lead && now < state.lagFrom ? .08 : 1;
        body.v += (stiffness * (target.x - body.x) - damping * body.v) * dt * factor;
        body.x += body.v * dt;

        const low = PAD + 6 + state.q + target.r - 3;
        const high = PAD + state.w - 6 - state.q - target.r + 3;
        if (body.x < low || body.x > high) {
          state.sy.v -= Math.min(Math.abs(body.v), 900) * .0016;
          body.x = Math.max(low, Math.min(high, body.x));
          body.v *= -.25;
        }

        if (Math.abs(target.x - body.x) > .3 || Math.abs(body.v) > 3) still = false;
      });

      const leadBody = bodies[state.lead];
      const targetSy = 1 - .14 * Math.min(Math.abs(leadBody.v) / 1500, 1);
      state.sy.v += (280 * (targetSy - state.sy.s) - 9 * state.sy.v) * dt;
      state.sy.s += state.sy.v * dt;
      if (Math.abs(state.sy.s - 1) > .002 || Math.abs(state.sy.v) > .02) still = false;

      const separation = Math.abs(state.a.x - state.b.x);
      const radius = target.r * (1 - .3 * Math.min(
        separation / (2 * (target.q + target.r) || 1),
        1,
      ));

      if (
        !state.split
        && state.moving
        && separation - 2 * target.q - 2 * radius > -6
      ) {
        state.split = true;
        const tailBody = bodies[1 - state.lead];
        const headBody = bodies[state.lead];
        // 只留两滴更小的拖尾：保留切换的液态感，但把收尾的“甩尾”弱化。
        [.38, .62].forEach((ratio, index) => {
          state.sats.push({
            x: tailBody.x + (headBody.x - tailBody.x) * ratio + (Math.random() - .5) * 6,
            y: target.cy + (Math.random() - .5) * 10,
            vx: (tailBody.v + headBody.v) * .38,
            vy: (Math.random() - .5) * 60,
            r: 4 + Math.random() * 2 - index * .35,
            k: 55 + Math.random() * 45,
          });
        });
      }

      state.sats = state.sats.filter((satellite) => {
        satellite.vx += (satellite.k * (target.x - satellite.x) - 9 * satellite.vx) * dt;
        satellite.vy += (90 * (target.cy - satellite.y) - 7 * satellite.vy) * dt;
        satellite.x += satellite.vx * dt;
        satellite.y += satellite.vy * dt;
        satellite.x = Math.max(
          PAD + 8 + satellite.r,
          Math.min(PAD + state.w - 8 - satellite.r, satellite.x),
        );
        satellite.y = Math.max(
          target.cy - target.r + satellite.r,
          Math.min(target.cy + target.r - satellite.r, satellite.y),
        );
        if (Math.abs(target.x - satellite.x) < target.q + target.r * .5) {
          satellite.r -= dt * 38;
        }
        return satellite.r > .5;
      });
      if (state.sats.length) still = false;

      if (state.moving && still) {
        state.moving = false;
        state.rips.push({
          x: target.x,
          y: target.cy,
          age: 0,
          amp: state.split ? .75 : .45,
        });
      }

      state.rips.forEach((ripple) => {
        ripple.age += dt;
      });
      state.rips = state.rips.filter((ripple) => ripple.age < 1.8);
      state.mouse.s += ((state.mouse.on ? 1 : 0) - state.mouse.s) * Math.min(1, dt * 7);
    }

    function loop() {
      if (state.raf) return;
      if (typeof window.requestAnimationFrame !== "function") return;
      state.last = performance.now();

      const tick = (now: number) => {
        const dt = Math.min((now - state.last) / 1000, 1 / 30);
        state.last = now;
        step(dt, now);
        draw();

        const busy = state.moving
          || state.rips.length > 0
          || state.sats.length > 0
          || state.mouse.s > .01;
        // 只有还在动 / 涟漪未散 / 鼠标弯月面未收 / 900ms 静止窗口内才继续；
        // 否则停掉 rAF（下一次交互再 wake）。
        if (busy || now < state.holdUntil) {
          state.raf = window.requestAnimationFrame(tick);
        } else {
          state.raf = 0;
        }
      };

      state.raf = window.requestAnimationFrame(tick);
    }

    const localPoint = (clientX: number, clientY: number) => {
      const rect = pill.getBoundingClientRect();
      return { x: clientX - rect.left + PAD, y: clientY - rect.top + PAD };
    };

    const ripple = (x: number, y: number, amp: number) => {
      state.rips.push({ x, y, age: 0, amp });
      wake();
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      const point = localPoint(event.clientX, event.clientY);
      state.mouse.x = point.x;
      state.mouse.y = point.y;
      state.mouse.on = true;
      wake();
    };

    const onPointerLeave = () => {
      state.mouse.on = false;
      wake();
    };

    const onPointerDown = (event: PointerEvent) => {
      const point = localPoint(event.clientX, event.clientY);
      ripple(point.x, point.y, .85);
    };

    pill.addEventListener("pointermove", onPointerMove);
    pill.addEventListener("pointerleave", onPointerLeave);
    pill.addEventListener("pointerdown", onPointerDown);
    cleanups.push(() => {
      pill.removeEventListener("pointermove", onPointerMove);
      pill.removeEventListener("pointerleave", onPointerLeave);
      pill.removeEventListener("pointerdown", onPointerDown);
    });

    let themeObserver: MutationObserver | null = null;
    if (typeof MutationObserver === "function") {
      themeObserver = new MutationObserver(() => wake());
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });
      cleanups.push(() => themeObserver?.disconnect());
    }

    // WebGL context 丢失时不能把画面留在最后一帧：立即退回 CSS 液滴。
    const onContextLost = (event: Event) => {
      event.preventDefault();
      if (state.raf) {
        window.cancelAnimationFrame(state.raf);
        state.raf = 0;
      }
      fallbackToCssDrop();
    };
    canvas.addEventListener("webglcontextlost", onContextLost);
    cleanups.push(() => canvas.removeEventListener("webglcontextlost", onContextLost));

    measureRef.current = measure;
    resizeLayout = () => {
      state.ready = false;
      measure();
    };
    cleanups.push(() => {
      if (state.raf) window.cancelAnimationFrame(state.raf);
      state.raf = 0;
      if (program) glContext.deleteProgram(program);
      pill.removeAttribute("data-liquid-gl");
      canvas.style.display = "none";
    });

    measure();

    return () => {
      for (const cleanup of cleanups.reverse()) cleanup();
      measureRef.current = null;
    };
  }, []);

  // 激活项 / “更多”打开状态变化后重新测量一次；DOM 的 aria-current 变化
  // 另由 MutationObserver 覆盖，两条路径互不依赖。
  useLayoutEffect(() => {
    measureRef.current?.();
  }, [activeKey]);

  return (
    <>
      <canvas ref={canvasRef} className={canvasClassName} aria-hidden="true" />
      <span
        ref={dropRef}
        className={dropClassName}
        data-liquid-drop="true"
        aria-hidden="true"
      />
    </>
  );
}
