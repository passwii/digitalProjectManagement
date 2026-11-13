"use client";

import { useLayoutEffect, useRef } from "react";
import {
  LIQUID_STEP,
  liquidAtRest,
  liquidStretchAtRest,
  stepLiquid,
  stepLiquidStretch,
  type LiquidBody,
  type LiquidStretch,
} from "@/lib/liquidNavMotion";

/**
 * 液态导航（React 版）。
 *
 * 方案 B（2026-11-13 定稿，见 docs/prototypes/navbar-motion）：
 *   · 一个液滴，位移由单体弹簧推进（固定 1/240 子步，60/120Hz 手感一致），
 *     346px 位移约 325ms 落位、只有一次约 6% 的回弹；
 *   · 位移速度带来最多 +8% 的横向拉伸，到位后回落到 1；
 *   · 不再有双体跟随 / 分裂小滴 / 落点涟漪 / 点击涟漪；
 *   · 鼠标弯月面保留（悬停反馈，不属于切换动效）；
 *   · 静止 IDLE_HOLD_MS 后停 rAF，不在页面后台持续烧 GPU；
 *   · prefers-reduced-motion、WebGL 不可用、context lost 都退回 CSS 液滴。
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

interface EngineState {
  a: LiquidBody;
  stretch: LiquidStretch;
  q: number;
  mouse: { x: number; y: number; s: number; on: boolean };
  moving: boolean;
  ready: boolean;
  w: number;
  h: number;
  raf: number;
  last: number;
  acc: number;
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
      stretch: { s: 1, v: 0 },
      q: 0,
      mouse: { x: 0, y: 0, s: 0, on: false },
      moving: false,
      ready: false,
      w: 0,
      h: 0,
      raf: 0,
      last: 0,
      acc: 0,
      time: 0,
      holdUntil: 0,
    };
    /** 目标几何：由激活项量出来；位移目标是 state.a 的弹簧目标。 */
    const target = { x: 0, cy: 0, q: 0, r: 21 };

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

      const previousX = target.x;
      target.r = element.offsetHeight / 2;
      target.q = Math.max(0, element.offsetWidth / 2 - target.r);
      target.cy = PAD + element.offsetTop + element.offsetHeight / 2;
      const nextX = PAD + element.offsetLeft + element.offsetWidth / 2;
      target.x = nextX;

      if (!state.ready) {
        // 首次挂载 / resize：直接落到位置，不做入场动画。
        state.a.x = nextX;
        state.a.v = 0;
        state.q = target.q;
        state.stretch.s = 1;
        state.stretch.v = 0;
        state.ready = true;
      } else if (Math.abs(nextX - previousX) > 0.5) {
        // 只把位移交给弹簧；拉伸由速度在 step 里自己算。
        state.moving = true;
      }
      resizeCanvas();
      wake();
    };

    const draw = () => {
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

      // 只有一个液滴：拉伸是沿胶囊长轴的对称放大，其余 blob 保持未激活（w=0）。
      const blobs = new Float32Array(24);
      const sy = new Float32Array(6).fill(1);
      const capsule = Math.max(0, state.q * state.stretch.s);
      blobs.set([state.a.x, target.cy, capsule, target.r], 0);

      glContext.uniform4fv(uniforms.uBlob, blobs);
      glContext.uniform1fv(uniforms.uSy, sy);

      // 方案 B 没有落点涟漪：uRip 全零，shader 的 waves() 只剩鼠标弯月面。
      const ripples = new Float32Array(24);
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

    /** 单个子步：位移弹簧 + 横向拉伸 + q 平滑 + 鼠标弯月面。 */
    function step(dt: number) {
      state.time += dt;
      stepLiquid(state.a, target.x, dt);
      stepLiquidStretch(state.stretch, state.a.v, dt);
      state.q += (target.q - state.q) * Math.min(1, dt * 16);

      // 落位以液滴位移为准（约 325ms）；拉伸是副产品，由 busy 继续收尾。
      if (state.moving && liquidAtRest(state.a, target.x)) {
        state.moving = false;
      }

      state.mouse.s += ((state.mouse.on ? 1 : 0) - state.mouse.s) * Math.min(1, dt * 7);
    }

    function loop() {
      if (state.raf) return;
      if (typeof window.requestAnimationFrame !== "function") return;
      state.last = performance.now();

      const tick = (now: number) => {
        state.raf = 0;
        // 固定 1/240 子步：rAF 的间隔只决定这一帧补几步，不改手感。
        const raw = Math.max(0, Math.min((now - state.last) / 1000, 1 / 15));
        state.last = now;
        state.acc += raw;
        let guard = 0;
        while (state.acc >= LIQUID_STEP && guard < 48) {
          step(LIQUID_STEP);
          state.acc -= LIQUID_STEP;
          guard += 1;
        }
        draw();

        // 拉伸虽然肉眼几乎看不见，也要等它回到 1 再停，免得留下残余形变。
        const busy = state.moving
          || !liquidStretchAtRest(state.stretch)
          || state.mouse.s > .01;
        // 只有还在动 / 鼠标弯月面未收 / 900ms 静止窗口内才继续；
        // 否则停掉 rAF（下一次交互再 wake）。
        if (busy || now < state.holdUntil) {
          state.raf = window.requestAnimationFrame(tick);
        }
      };

      state.raf = window.requestAnimationFrame(tick);
    }

    const localPoint = (clientX: number, clientY: number) => {
      const rect = pill.getBoundingClientRect();
      return { x: clientX - rect.left + PAD, y: clientY - rect.top + PAD };
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

    pill.addEventListener("pointermove", onPointerMove);
    pill.addEventListener("pointerleave", onPointerLeave);
    cleanups.push(() => {
      pill.removeEventListener("pointermove", onPointerMove);
      pill.removeEventListener("pointerleave", onPointerLeave);
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
