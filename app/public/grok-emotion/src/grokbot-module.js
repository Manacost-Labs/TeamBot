/**
 * ============================================================================
 * GROK BOT — the animated, cursor-following character
 * ============================================================================
 *
 * The animated half of the bot: a faithful reproduction of the interactive
 * Grok Bot icon from x.ai/bot (indentation + comments added for readability).
 *
 * What it is:
 *   - a forwardRef React component that renders <svg class="grok-bot-mark">
 *   - a state machine (30+ states) mapped to eye expressions
 *   - a tiny physics engine (critically-damped springs) driving every
 *     animated property — nothing is CSS-animated
 *   - a requestAnimationFrame loop that writes SVG attributes directly via
 *     refs, so React never re-renders during animation
 *   - optional cursor tracking (mouseInteractive) that makes the eyes follow
 *     the pointer
 *
 * Imports:
 *   jsx-runtime · react · EXPRESSIONS · geometry helpers · SHAPES
 *   (the data modules come from shapes-module.js)
 * ============================================================================
 */
(t) => {
  "use strict";
  /* imports: react/jsx-runtime + the three data modules from
   * shapes-module.js. The minified names (t, e, r, ...) are kept on purpose
   * to stay close to the original implementation. */
  let e, r, i, a, n, s, l, o;
  var u,
    h,
    d = t.i(73709),
    c = t.i(533885),
    M = t.i(643315),
    x = t.i(357716),
    p = t.i(259454);
  try {
    var b = window;
    ((b._sentryModuleMetadata = b._sentryModuleMetadata || {}),
      (b._sentryModuleMetadata[new b.Error().stack] = Object.assign(
        {},
        b._sentryModuleMetadata[new b.Error().stack],
        { "_sentryBundlerPluginAppKey:website": !0 },
      )));
  } catch (t) {}
  /* ---- the state catalog ------------------------------------------------
   * Every state below is supported. The hero title cycles
   * waking -> idle -> happy -> idle -> curious; the footer character cycles
   * idle -> curious -> bored -> happy -> playful.
   */
  [
    {
      label: "Lifecycle",
      states: [
        "sleeping",
        "waking",
        "idle",
        "listening",
        "thinking",
        "searching",
        "working",
      ],
    },
    {
      label: "Reactions",
      states: [
        "excited",
        "surprised",
        "suspicious",
        "angry",
        "drowsy",
        "happy",
        "curious",
        "confused",
        "bored",
        "proud",
        "shy",
        "sad",
        "laughing",
        "scared",
        "playful",
        "celebrate",
      ],
    },
    { label: "Agent morphs", states: ["orbit", "radar", "progress"] },
    {
      label: "Product lifecycle",
      states: [
        "spawning",
        "humming",
        "loading",
        "dictating",
        "writing",
        "sending",
        "receiving",
        "uploading",
        "notifying",
        "alerting",
        "dragging",
        "bouncing",
        "powering-down",
      ],
    },
  ].flatMap((t) => t.states);
  /* ---- behaviour tables ---------------------------------------------------
   * g / y : "progress" & "spawning" hold their ring effect until the ring
   *         has been shown for a while (then release it)
   * f     : state -> WHICH expressions to randomly switch between
   *         (indices into EXPRESSIONS; e.g. happy = [2, 11, 17, 19])
   * A     : state -> [min, max] ms between expression switches
   * m     : state -> [min, max] ms between gaze drifts (null = no drift)
   */
  let g = new Set(["progress", "spawning"]),
    y = { progress: 2500, spawning: 2e3 },
    f = {
      sleeping: [13, 22, 4],
      waking: [13],
      idle: [0, 8],
      listening: [10, 1, 19],
      thinking: [8, 16, 14, 17, 5],
      searching: [15, 9, 3, 20, 12, 18],
      working: [7, 16, 11, 10],
      excited: [2, 17, 21, 3, 11],
      surprised: [3, 21],
      suspicious: [14, 5, 23],
      angry: [7, 16],
      drowsy: [4, 22, 13],
      happy: [2, 11, 17, 19],
      curious: [3, 21, 0, 15],
      confused: [14, 5, 8],
      bored: [4, 22, 0],
      proud: [15, 8, 2],
      shy: [0, 24, 13],
      sad: [4, 13, 22],
      laughing: [2, 11, 17],
      scared: [3, 21],
      playful: [2, 17, 11, 8],
      celebrate: [2, 8, 17],
      orbit: [0, 8],
      radar: [0, 8],
      progress: [0, 8],
      spawning: [3, 0],
      humming: [0, 8],
      loading: [0, 8],
      dictating: [10, 1, 19],
      sending: [0, 8],
      receiving: [19, 0, 8],
      uploading: [15, 9, 8],
      writing: [15, 9],
      notifying: [3, 21, 0],
      alerting: [3, 21],
      bouncing: [2, 17],
      dragging: [3, 15, 0],
      "powering-down": [13, 22],
    },
    A = {
      sleeping: [6e3, 1e4],
      waking: [800, 800],
      idle: [9e3, 16e3],
      listening: [2800, 5e3],
      thinking: [2e3, 3600],
      searching: [1e3, 1800],
      working: [1800, 3200],
      excited: [1100, 2e3],
      surprised: [2500, 4e3],
      suspicious: [2600, 4500],
      angry: [2200, 3800],
      drowsy: [4e3, 8e3],
      happy: [2500, 4500],
      curious: [1800, 3200],
      confused: [2200, 3800],
      bored: [3500, 6e3],
      proud: [3500, 6e3],
      shy: [3e3, 5500],
      sad: [4e3, 7e3],
      laughing: [1200, 2400],
      scared: [900, 1800],
      playful: [1500, 3e3],
      celebrate: [1400, 2600],
      orbit: [4e3, 8e3],
      radar: [4e3, 8e3],
      progress: [4e3, 8e3],
      spawning: [1200, 1200],
      humming: [5e3, 9e3],
      loading: [6e3, 1e4],
      dictating: [4e3, 8e3],
      sending: [4e3, 8e3],
      receiving: [4e3, 8e3],
      uploading: [4e3, 8e3],
      writing: [4e3, 8e3],
      notifying: [1500, 2600],
      alerting: [2e3, 3600],
      bouncing: [3e3, 6e3],
      dragging: [1600, 3e3],
      "powering-down": [6e3, 9e3],
    },
    m = {
      sleeping: null,
      waking: null,
      idle: [6e3, 14e3],
      listening: [3e3, 7e3],
      thinking: [3500, 7e3],
      searching: [1600, 4e3],
      working: [2800, 5500],
      excited: [2e3, 4e3],
      surprised: [1800, 3500],
      suspicious: [4500, 8e3],
      angry: [3500, 7e3],
      drowsy: null,
      happy: [2500, 5e3],
      curious: [2500, 5500],
      confused: [2800, 5500],
      bored: [4e3, 8e3],
      proud: [3500, 7e3],
      shy: [3e3, 6e3],
      sad: [4e3, 8e3],
      laughing: [2500, 5e3],
      scared: [1200, 3e3],
      playful: [2e3, 4500],
      celebrate: [2200, 4500],
      orbit: null,
      radar: null,
      progress: null,
      spawning: null,
      humming: [4e3, 8e3],
      loading: null,
      dictating: null,
      sending: null,
      receiving: null,
      uploading: null,
      writing: null,
      notifying: [2e3, 4e3],
      alerting: null,
      bouncing: null,
      dragging: [2200, 4500],
      "powering-down": null,
    },
  /* states that randomly celebrate (spin / bounce / confetti) now and then */
    E = new Set(["happy", "excited", "proud"]),
    w = new Set(["playful"]);
  try {
    var F = window;
    ((F._sentryModuleMetadata = F._sentryModuleMetadata || {}),
      (F._sentryModuleMetadata[new F.Error().stack] = Object.assign(
        {},
        F._sentryModuleMetadata[new F.Error().stack],
        { "_sentryBundlerPluginAppKey:website": !0 },
      )));
  } catch (t) {}
  /* ---- physics & easing ---------------------------------------------------
   * _ (spring) : { x: current, v: velocity, t: target } — every animated
   *              property is one of these objects.
   * k()        : one critically-damped spring integration step:
   *              v += (-2·zeta·omega·v - omega^2·(x - target))·dt
   * C = 1/120  : fixed simulation timestep (seconds)
   * v(a, b)    : random float in [a, b)
   * H(x,a,b)   : clamp
   * $ / D / P / S : easeInOutCubic / easeOutCubic / backOut / smoothstep
   */
  let _ = (t) => ({ x: t, v: 0, t: t }),
    k = (t, e, r, i) => {
      ((t.v += (-2 * r * e * t.v - e * e * (t.x - t.t)) * i),
        (t.x += t.v * i),
        (Number.isFinite(t.x) && Number.isFinite(t.v)) ||
          ((t.x = t.t), (t.v = 0)));
    },
    C = 1 / 120,
    v = (t, e) => t + Math.random() * (e - t),
    H = (t, e, r) => Math.min(r, Math.max(e, t)),
    $ = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    D = (t) => 1 - Math.pow(1 - t, 3),
    P = (t) => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2),
    S = (t) => t * t * (3 - 2 * t);
  try {
    var R = window;
    ((R._sentryModuleMetadata = R._sentryModuleMetadata || {}),
      (R._sentryModuleMetadata[new R.Error().stack] = Object.assign(
        {},
        R._sentryModuleMetadata[new R.Error().stack],
        { "_sentryBundlerPluginAppKey:website": !0 },
      )));
  } catch (t) {}
  /* particle palette + SVG namespace */
  let I = ["#f9705c", "#5b95f0", "#3fbe86", "#f5b13f", "#9a72ee", "#35c3bd"],
    j = "http://www.w3.org/2000/svg";
  try {
    var N = window;
    ((N._sentryModuleMetadata = N._sentryModuleMetadata || {}),
      (N._sentryModuleMetadata[new N.Error().stack] = Object.assign(
        {},
        N._sentryModuleMetadata[new N.Error().stack],
        { "_sentryBundlerPluginAppKey:website": !0 },
      )));
  } catch (t) {}
  try {
    var O = window;
    ((O._sentryModuleMetadata = O._sentryModuleMetadata || {}),
      (O._sentryModuleMetadata[new O.Error().stack] = Object.assign(
        {},
        O._sentryModuleMetadata[new O.Error().stack],
        { "_sentryBundlerPluginAppKey:website": !0 },
      )));
  } catch (t) {}
  /* ---- ring effects ---------------------------------------------------------
   * B       : the 14 effect ring types
   *           (dots, orbit, radar, progress, gather, wave, send, receive,
   *           dock, ball, whirl, pencil, bang, standby)
   * L       : state -> effect ring type (thinking->dots, sending->send, ...)
   * z       : pre-rendered outline of the plain circle ring
   * V / K   : the "pencil" ring (a half-offset teardrop ring) and picker
   * T       : how much each effect zooms the viewBox
   * G / X   : glyph paths — the pencil ("writing") and bang ("alerting") icons
   * W       : face-params lerp used when morphing between shapes
   * U / q   : blink envelope — a 4-step {height, duration} squash-and-stretch
   */
  let B = [
      "dots",
      "orbit",
      "radar",
      "progress",
      "gather",
      "wave",
      "send",
      "receive",
      "dock",
      "ball",
      "whirl",
      "pencil",
      "bang",
      "standby",
    ],
    L = {
      thinking: "dots",
      orbit: "orbit",
      radar: "radar",
      progress: "progress",
      spawning: "gather",
      dictating: "wave",
      sending: "send",
      receiving: "receive",
      uploading: "dock",
      bouncing: "ball",
      loading: "whirl",
      "powering-down": "standby",
      writing: "pencil",
      alerting: "bang",
    },
    z = (0, p.ringOutline)(p.CIRCLE_RING),
    V =
      ((u = p.SHAPES.teardrop.ring),
      (h = p.SHAPES.teardrop.ring.length / 2),
      (i = Math.cos((r = (h / (e = u.length)) * Math.PI * 2))),
      (a = Math.sin(r)),
      Array.from({ length: e }, (t, r) => {
        let [n, s] = u[(((r - h) % e) + e) % e],
          l = n - x.HEAD_C,
          o = s - x.HEAD_C;
        return [x.HEAD_C + l * i - o * a, x.HEAD_C + l * a + o * i];
      })),
    K = (t) => ("pencil" === t ? V : p.CIRCLE_RING),
    T = {
      dots: 1.5,
      orbit: 1.14,
      radar: 1.14,
      progress: 1.32,
      gather: 1.15,
      wave: 1.42,
      send: 1.12,
      receive: 1.12,
      dock: 1.3,
      ball: 1.22,
      whirl: 1.45,
      pencil: 1.18,
      bang: 1.28,
      standby: 1.75,
    },
    G =
      ((n = x.HEAD_C - 44 + 15),
      (s = x.HEAD_C + 44 - 15),
      `M${x.HEAD_C - 15} ${n}A15 15 0 0 1 ${x.HEAD_C + 15} ${n}L${x.HEAD_C + 15} ${s}A15 15 0 0 1 ${x.HEAD_C - 15} ${s}Z`),
    X =
      ((l = x.HEAD_C - 48),
      (o = x.HEAD_C + 48),
      `M${x.HEAD_C - 15} ${l + 15}A15 15 0 0 1 ${x.HEAD_C + 15} ${l + 15}L${x.HEAD_C + 8.5} ${o - 8.5}A8.5 8.5 0 0 1 ${x.HEAD_C - 8.5} ${o - 8.5}Z`),
    W = (t, e, r) => ({
      x: t.x + (e.x - t.x) * r,
      y: t.y + (e.y - t.y) * r,
      sx: t.sx + (e.sx - t.sx) * r,
      sy: t.sy + (e.sy - t.sy) * r,
      eye: t.eye + (e.eye - t.eye) * r,
    }),
    U = [0, 0],
    q = [
      { h: 48, d: 0.5 },
      { h: 28, d: 0.382 },
      { h: 14, d: 0.27 },
      { h: 6, d: 0.177 },
    ],
  /* =========================================================================
   * THE COMPONENT — GrokBot
   *
   * Props:
   *   state            "idle"     — one of the 30+ states
   *   shape            "blob"     — head silhouette (a SHAPES key)
   *   size             undefined  — px; undefined = fill parent (width:100%)
   *   className        undefined  — appended to "grok-bot-mark"
   *   gazeTarget       null       — fixed {x, y} point to look at
   *   mouseInteractive false      — eyes follow the cursor
   *   flipX            false      — mirror horizontally
   *   emphasis         false      — slightly larger head
   *   spinSignal       number     — >0 triggers one spin
   *   badgeColor / badgeScale     — the notification dot
   *
   * Imperative handle: spin(), bounce(), burst().
   * =========================================================================
   */
    Y = (0, c.forwardRef)(function (
      {
        state: t = "idle",
        shape: e = "blob",
        size: r,
        className: i,
        gazeTarget: a = null,
        mouseInteractive: n = !1,
        flipX: s = !1,
        emphasis: l = !1,
        spinSignal: o = 0,
        badgeColor: u = "var(--gb-badge, #1d9bf0)",
        badgeScale: h = 1,
      },
      b,
    ) {
    /* refs: F = unique clipPath id · R = <svg> · N = inner <g> (the body) ·
     * O / V = hidden layers used by the particle system */
      let F = (0, c.useId)().replace(/[:]/g, ""),
        R = (0, c.useRef)(null),
        N = (0, c.useRef)(null),
        O = (0, c.useRef)(null),
        V = (0, c.useRef)(null),
      /* pointer-tracking hook (when mouseInteractive): an IntersectionObserver
     * gates the listener, then window "pointermove" feeds a {x, y} ref that
     * the animation loop turns into a gaze direction */
      Y = (function (t, e = !0) {
          let r = (0, c.useRef)({ x: 0, y: 0 }),
            i = (0, c.useRef)(!1),
            [a, n] = (0, c.useState)(!1),
            [s, l] = (0, c.useState)(!1);
          return (
            (0, c.useEffect)(() => {
              if (!e) return;
              let r = t.current;
              if (!r) return;
              let i = new IntersectionObserver(([t]) => {
                n(t?.isIntersecting ?? !1);
              });
              return (i.observe(r), () => i.disconnect());
            }, [t, e]),
            (0, c.useEffect)(() => {
              if (!e || !a) return;
              let t = (t) => {
                ((r.current.x = t.clientX),
                  (r.current.y = t.clientY),
                  i.current || ((i.current = !0), l(!0)));
              };
              return (
                window.addEventListener("pointermove", t, { passive: !0 }),
                () => window.removeEventListener("pointermove", t)
              );
            }, [a, e]),
            e && a && s ? r.current : null
          );
        })(R, n),
        Z = (0, c.useRef)(a);
      Z.current = a ?? Y;
      let J = (0, c.useRef)(s);
      J.current = s;
      let Q = (0, c.useRef)(l);
      Q.current = l;
      let tt = (0, c.useRef)(u);
      tt.current = u;
      let te = (0, c.useRef)(h);
      te.current = h;
      let tr = (0, c.useRef)({
        spin: () => {},
        bounce: () => {},
        burst: () => {},
      });
      (0, c.useImperativeHandle)(
        b,
        () => ({
          spin: (t) => tr.current.spin(t),
          bounce: () => tr.current.bounce(),
          burst: () => tr.current.burst(),
        }),
        [],
      );
    /* live shape name (read by the loop so a shape change can morph mid-flight) */
      let ti = (0, c.useRef)(e);
      ti.current = e;
      let ta = (0, c.useRef)(null),
        tn = (0, c.useRef)(null);
      (0, c.useEffect)(() => {
        o > 0 && tr.current.spin();
      }, [o]);
    /* SVG node collections:
     * ts — the two eye <path>s       tl — two "dot" <path>s
     * to — notification dot <circle> tu — three glyph <path>s (pencil/bang...)
     * th — five "part" <circle>s     td — five ring <circle>s
     */
      let ts = (0, c.useRef)([]),
        tl = (0, c.useRef)([]),
        to = (0, c.useRef)(null),
        tu = (0, c.useRef)([]),
        th = (0, c.useRef)([]),
        td = (0, c.useRef)([]),
        tc = (0, c.useRef)(t),
        tM = (0, c.useRef)(0);
    /* keep the latest state + its start time in refs for the loop */
      ((0, c.useEffect)(() => {
        ((tc.current = t), (tM.current = performance.now()));
      }, [t]),
      /* =======================================================================
     * THE ANIMATION LOOP — everything below runs once on mount and then on
     * every requestAnimationFrame tick. Nothing here re-renders React: SVG
     * attributes are written straight through the refs.
     * =======================================================================
     */
      (0, c.useEffect)(() => {
      /* reduceMotion ? the loop still runs but all randomness/timing collapses.
       * e = current eye rings, r = target eye rings */
          let t = window.matchMedia("(prefers-reduced-motion: reduce)").matches,
            e = [M.EXPRESSIONS[0][0], M.EXPRESSIONS[0][1]],
            r = e,
            i = _(1),
            a = 0,
            n = _(0),
            s = _(0),
            l = _(0),
            o = _(1),
            u = _(1),
            h = _(1),
            d = _(0),
            c = _(0),
            b = 0,
            Y = 0,
            tx = -1e9,
            tp = 0,
            tb = _(1),
            tg = ti.current,
            ty = p.SHAPES[tg].ring,
            tf = p.SHAPES[tg].face,
            tA = p.SHAPES[tg].tiltScale,
            tm = p.SHAPES[tg].beltRadius,
            tE = p.SHAPES[tg].beltRadius,
            tw = _(0),
            tF = _(1),
            t_ = null,
            tk = null,
            tC = null,
            tv = 0,
            tH = !1,
            t$ = 0,
            tD = _(0),
            tP = 0,
            tS = 1,
            tR = !1,
            tI = -1e9,
            tj = Math.PI,
            tN = null,
            tO = 0,
            tB = 0,
            tL = 0,
            tz = 0,
            tV = 0,
            tK = 0,
            tT = 0,
            tG = [],
            tX = 0,
            tW = 0,
            tU = -1,
            tq = 0,
            tY = _(0),
            tZ = _(0),
            tJ = [],
            tQ = -1,
            t1 = -0.7,
            t0 = 0,
            t2 = performance.now(),
            t5 = 0,
            t3 = performance.now(),
            t4 = null,
            t6 = -1e9,
      /* t8(expressionIndex, strength) — start morphing the eyes toward a new
       * expression; the cross-fade itself is driven by the spring i */
            t8 = (t, n = 7) => {
              if (t === a && 1 === i.t) return;
              let s = Math.min(Math.max(i.x, 0), 1);
              ((e = [
                (0, x.lerpRing)(e[0], r[0], s),
                (0, x.lerpRing)(e[1], r[1], s),
              ]),
                (r = [M.EXPRESSIONS[t][0], M.EXPRESSIONS[t][1]]),
                (a = t),
                (i.x = 0),
                (i.v = 0),
                (i.t = 1),
                (t9 = n));
            },
            t9 = 7,
            t7 = null,
            et = { x: 0, y: 0, tx: 0, ty: 0 },
            ee = 0,
            er = 1 / 60,
            ei = 1,
            ea = 380,
            en = "",
            es = 0,
            el = (t) => 1 - Math.exp(60 * Math.log(1 - t) * er),
            eo = (t = 1, e = 0.5 > Math.random() ? 1 : -1) => {
              t7 || (t7 = { x: 0, v: 0, t: t * Math.PI * 2 * e });
            },
            eu = t3 + v(2500, 5e3),
            eh = !1,
      /* ed — the particle system (celebration bursts / confetti). Spawns
       * coloured particles on the hidden back/front layers, integrates
       * gravity & curl noise, renders circles and stars. */
            ed = (function ({
              back: t,
              front: e,
              idPrefix: r,
              reduceMotion: i,
              radius: a,
            }) {
              let n = () => a() / 114.2705,
                s = 0,
                l = 1,
                o = !1,
                u = [],
                h = v(0, 2 * Math.PI),
                d = !1,
                c = [],
                M = 0,
                p = [],
                b = 0,
                g = 4,
                y = (t = 1) => {
                  let e = v(-0.85, 0.85);
                  p = [];
                  for (let r = 0; r < t; r++)
                    p.push({
                      tilt: v(0.16, 0.5),
                      roll: e + (r * Math.PI) / t + v(-0.12, 0.12),
                    });
                  ((g = t > 1 ? 3 * t : Math.round(v(3, 5))), (b = v(0, 360)));
                },
                f = (t, e, r) => {
                  if (u.length > 110) return;
                  p.length || y();
                  let i = p[r % p.length];
                  u.push({
                    x: x.HEAD_C,
                    y: x.HEAD_C,
                    vx: 0,
                    vy: 0,
                    ret: 0,
                    life: 0,
                    max: 9,
                    r:
                      (g <= 3
                        ? v(8, 10.5)
                        : 4 === g
                          ? v(6.6, 8.6)
                          : v(5.6, 7.4)) * 1,
                    rot: v(0, 360),
                    vr: v(-240, 240),
                    curl: 0,
                    color: I[(Math.random() * I.length) | 0],
                    round: !0,
                    star: !1,
                    hue: b + (360 * r) / Math.max(g, 1) + v(-14, 14),
                    hueSpan: v(45, 95) * (0.5 > Math.random() ? 1 : -1),
                    hueVel: v(18, 42) * (0.5 > Math.random() ? 1 : -1),
                    orbit: {
                      lam: t,
                      lamVel: e * v(0.5, 1.1),
                      tilt: i.tilt + v(-0.04, 0.04),
                      roll: i.roll + v(-0.05, 0.05),
                      rad:
                        116 * n() +
                        ((r / p.length) | 0) *
                          (38 / Math.max(Math.ceil(g / p.length) - 1, 1)) +
                        v(-1.5, 1.5),
                      radVel: v(0, 2.5),
                      follow: v(0.74, 0.94),
                      carry: 0,
                      arc: +v(2.2, 3.4),
                    },
                    hist: [],
                    el: null,
                  });
                },
                A = 0,
                m = 0,
                E = (t) => Math.round(10 * t) / 10,
                w = (t, e) => {
                  let r = t.length,
                    i = 0;
                  for (let e = 1; e < r; e++)
                    i += Math.hypot(t[e].x - t[e - 1].x, t[e].y - t[e - 1].y);
                  let a = Math.min(e, 0.34 * i),
                    n = [],
                    s = [];
                  for (let e = 0; e < r; e++) {
                    let i = t[e > 0 ? e - 1 : 0],
                      l = t[e < r - 1 ? e + 1 : r - 1],
                      o = l.x - i.x,
                      u = l.y - i.y,
                      h = Math.hypot(o, u) || 1;
                    ((o /= h), (u /= h));
                    let d = (a * (0.5 + (e / (r - 1)) * 0.5)) / 2;
                    (n.push(-u * d), s.push(o * d));
                  }
                  let l = (t) => {
                      let e = Math.max(Math.hypot(n[t], s[t]), 0.2);
                      return `A${E(e)} ${E(e)} 0 0 0 `;
                    },
                    o = (e, i) => {
                      let a = "";
                      for (let r = e; r <= i; r++)
                        a += `${r === e ? "M" : "L"}${E(t[r].x + n[r])} ${E(t[r].y + s[r])}`;
                      a += i === r - 1 ? l(i) : "L";
                      for (let r = i; r >= e; r--)
                        a += `${r === i ? "" : "L"}${E(t[r].x - n[r])} ${E(t[r].y - s[r])}`;
                      return (
                        0 === e &&
                          (a += `${l(0)}${E(t[0].x + n[0])} ${E(t[0].y + s[0])}`),
                        a + "Z"
                      );
                    };
                  if (i < 2) return { front: "", back: "" };
                  let u = "",
                    h = "",
                    d = 0;
                  for (; d < r;) {
                    let e = t[d].z >= 0,
                      i = d;
                    for (; i + 1 < r && t[i + 1].z >= 0 === e;) i++;
                    let a = Math.max(d - 1, 0),
                      n = Math.min(i + 1, r - 1);
                    if (n > a) {
                      let t = o(a, n);
                      e ? (u += t) : (h += t);
                    }
                    d = i + 1;
                  }
                  return { front: u, back: h };
                },
                F = (t, e) => {
                  let r = t.rad * Math.sin(e),
                    i = -t.rad * Math.cos(e) * Math.sin(t.tilt),
                    a = Math.cos(t.roll),
                    n = Math.sin(t.roll);
                  return {
                    x: x.HEAD_C + r * a - i * n,
                    y: x.HEAD_C + r * n + i * a,
                  };
                },
                _ = (t, e) => Math.cos(e) * Math.cos(t.tilt);
              return {
                burst: (e = 20, r = 1, a = 0) => {
                  if (!i && t && !(u.length > 120))
                    for (let t = 0; t < e; t++) {
                      let i = (t / e) * Math.PI * 2 + v(-0.35, 0.35),
                        s = v(96, 116) * n(),
                        l = v(170, 360) * r,
                        o = -Math.sin(i),
                        h = Math.cos(i),
                        d = a * l * 0.2,
                        c = 0.18 > Math.random();
                      u.push({
                        x: x.HEAD_C + Math.cos(i) * s,
                        y: x.HEAD_C + Math.sin(i) * s,
                        vx: Math.cos(i) * l + o * d,
                        vy: Math.sin(i) * l + h * d - v(20, 75),
                        life: 0,
                        max: v(0.45, 0.85),
                        r: c ? v(4, 7) : v(3.5, 8),
                        rot: v(0, 360),
                        vr: v(-260, 260),
                        curl: 0,
                        color: c
                          ? x.STAR_GOLD
                          : I[(Math.random() * I.length) | 0],
                        round: !c && 0.3 > Math.random(),
                        star: c,
                        ret: 0,
                        orbit: null,
                        el: null,
                      });
                    }
                },
                update: (a, n, p) => {
                  let b, E, k;
                  if (
                    ((l = p.sizeScale),
                    (s = p.spinAngle),
                    (o = p.wideStyle),
                    (!isFinite((b = s - A)) || Math.abs(b) > 1.2) && (b = 0),
                    (A = s),
                    (E = Math.abs(m) >= 0.9),
                    (k = Math.abs((m = n > 0 ? b / n : 0)) >= 0.9),
                    !E && k && (y(o ? 3 : 1), (d = !1)),
                    E && !k && (c.length = 0),
                    !i && t)
                  ) {
                    if (((h = s), !d && Math.abs(m) >= 5)) {
                      ((d = !0), (c = []));
                      for (let t = 0; t < g; t++)
                        c.push({ at: a + t * v(55, 105), i: t });
                    }
                    for (; c.length && a >= c[0].at;) {
                      let t = c.shift();
                      f(h - v(0, 0.18), Math.sign(m) || 1, t.i);
                    }
                  }
                  ((i) => {
                    if (!t || !u.length) return;
                    let a = Math.abs(m) >= 0.9,
                      n = m,
                      s = m * i,
                      o = [];
                    for (let h of u) {
                      h.life += i;
                      let u = H(h.life / h.max, 0, 1);
                      if (h.orbit) {
                        let t = !a || u > 0.55;
                        if (
                          ((h.ret = H(h.ret + (t ? i / 0.5 : -i / 0.35), 0, 1)),
                          h.ret >= 1)
                        ) {
                          (h.trailEl?.remove(),
                            h.trailFrontEl?.remove(),
                            h.gradEl?.remove());
                          continue;
                        }
                      } else if (h.life >= h.max) {
                        h.el?.remove();
                        continue;
                      }
                      let d = h.orbit
                        ? Math.min(1, h.life / 0.26)
                        : u < 0.1
                          ? u / 0.1
                          : Math.pow(1 - (u - 0.1) / 0.9, 1.7);
                      if (h.orbit) {
                        let u = h.orbit;
                        (a
                          ? ((u.carry = n * u.follow),
                            (u.lam += s * u.follow + u.lamVel * i))
                          : ((u.lam += (u.carry + u.lamVel) * i),
                            (u.carry *= Math.exp(-2.6 * i)),
                            (u.lamVel *= Math.exp(-2.6 * i))),
                          (u.rad += u.radVel * i));
                        let c = F(u, u.lam);
                        ((h.x = c.x), (h.y = c.y));
                        let x = _(u, u.lam),
                          p = 0.72 + 0.28 * H(x, 0, 1),
                          b = Math.min(h.life / 0.34, 1),
                          g = b * b * (3 - 2 * b),
                          y = Math.max(
                            h.r * p * 1.7 * l * g * (1 - 0.72 * h.ret * h.ret),
                            0.5,
                          );
                        if (!h.trailEl) {
                          let i = document.createElementNS(j, "path");
                          (i.setAttribute("data-trail", ""),
                            i.setAttribute("stroke", "none"));
                          let a = document.createElementNS(j, "linearGradient"),
                            n = `${r}t${M++}`;
                          (a.setAttribute("id", n),
                            a.setAttribute("gradientUnits", "userSpaceOnUse"),
                            (h.stops = []));
                          for (let t = 0; t < 5; t++) {
                            let e = document.createElementNS(j, "stop");
                            (e.setAttribute("offset", (t / 4).toFixed(3)),
                              a.appendChild(e),
                              h.stops.push(e));
                          }
                          (t.appendChild(a),
                            (h.gradEl = a),
                            i.setAttribute("fill", `url(#${n})`),
                            t.appendChild(i),
                            (h.trailEl = i));
                          let s = document.createElementNS(j, "path");
                          (s.setAttribute("data-trail", ""),
                            s.setAttribute("stroke", "none"),
                            s.setAttribute(
                              "fill",
                              h.trailEl.getAttribute("fill") ?? h.color,
                            ),
                            e?.appendChild(s),
                            (h.trailFrontEl = s));
                        }
                        let f = h.hist,
                          A = f.length ? f[f.length - 1].l : u.lam,
                          m = u.lam - A,
                          E = Math.min(Math.ceil(Math.abs(m) / 0.09), 24);
                        for (let t = 1; t <= E; t++) {
                          let e = A + (m * t) / E,
                            r = F(u, e);
                          f.push({ x: r.x, y: r.y, l: e, z: _(u, e) });
                        }
                        f.length || f.push({ x: h.x, y: h.y, l: u.lam, z: x });
                        let k = u.arc * (1 - h.ret * h.ret * (3 - 2 * h.ret));
                        for (; f.length > 2 && Math.abs(u.lam - f[0].l) > k;)
                          f.shift();
                        let C = Math.abs(u.lam - f[0].l) - k;
                        if (f.length >= 2 && C > 0) {
                          let t = f[0].l + Math.sign(u.lam - f[0].l) * C,
                            e = F(u, t);
                          f[0] = { x: e.x, y: e.y, l: t, z: _(u, t) };
                        }
                        if (
                          (f.length > 48 && f.splice(0, f.length - 48),
                          f.length >= 2)
                        ) {
                          let { front: t, back: e } = w(f, y),
                            r = d.toFixed(3);
                          if (
                            (h.trailEl.setAttribute("d", e),
                            h.trailEl.setAttribute("opacity", r),
                            h.trailFrontEl?.setAttribute("d", t),
                            h.trailFrontEl?.setAttribute("opacity", r),
                            h.stops)
                          ) {
                            let t = (h.hue ?? 0) + (h.hueVel ?? 0) * h.life;
                            for (let e = 0; e < h.stops.length; e++) {
                              let r = e / (h.stops.length - 1),
                                i = t + r * (h.hueSpan ?? 120);
                              h.stops[e].setAttribute(
                                "stop-color",
                                `hsl(${(((i % 360) + 360) % 360).toFixed(0)} 56% ${(56 + 11 * r).toFixed(0)}%)`,
                              );
                            }
                          }
                          let i = f[0],
                            a = f[f.length - 1];
                          (h.gradEl?.setAttribute("x1", i.x.toFixed(1)),
                            h.gradEl?.setAttribute("y1", i.y.toFixed(1)),
                            h.gradEl?.setAttribute("x2", a.x.toFixed(1)),
                            h.gradEl?.setAttribute("y2", a.y.toFixed(1)));
                        } else
                          (h.trailEl.setAttribute("opacity", "0"),
                            h.trailFrontEl?.setAttribute("opacity", "0"));
                        o.push(h);
                        continue;
                      }
                      if (h.curl) {
                        let t = Math.cos(h.curl * i),
                          e = Math.sin(h.curl * i),
                          r = h.vx * t - h.vy * e,
                          a = h.vx * e + h.vy * t;
                        ((h.vx = r), (h.vy = a));
                      }
                      ((h.x += h.vx * i), (h.y += h.vy * i));
                      let c = Math.pow(0.94, 60 * i);
                      ((h.vx *= c), (h.vy = h.vy * c + 40 * i));
                      let p = h.life / h.max,
                        b =
                          p < 0.1
                            ? p / 0.1
                            : Math.pow(1 - (p - 0.1) / 0.9, 1.7),
                        g = Math.max(h.r * (1 - 0.4 * p), 0.5);
                      if (!h.el) {
                        let e = document.createElementNS(
                          j,
                          h.star ? "path" : h.round ? "circle" : "rect",
                        );
                        (h.star && e.setAttribute("d", x.STAR_PATH),
                          e.setAttribute("fill", h.color),
                          t.appendChild(e),
                          (h.el = e));
                      }
                      if ((h.el.setAttribute("opacity", b.toFixed(3)), h.star))
                        ((h.rot += h.vr * i),
                          h.el.setAttribute(
                            "transform",
                            `translate(${h.x.toFixed(1)} ${h.y.toFixed(1)}) rotate(${h.rot.toFixed(1)}) scale(${g.toFixed(2)})`,
                          ));
                      else if (h.round)
                        (h.el.setAttribute("cx", h.x.toFixed(1)),
                          h.el.setAttribute("cy", h.y.toFixed(1)),
                          h.el.setAttribute("r", g.toFixed(2)));
                      else {
                        let t = Math.max(
                            2 * g,
                            Math.min(0.05 * Math.hypot(h.vx, h.vy), 30),
                          ),
                          e = 1.5 * g,
                          r = (180 * Math.atan2(h.vy, h.vx)) / Math.PI;
                        (h.el.setAttribute("width", t.toFixed(1)),
                          h.el.setAttribute("height", e.toFixed(1)),
                          h.el.setAttribute("rx", (e / 2).toFixed(2)),
                          h.el.setAttribute("x", (h.x - t / 2).toFixed(1)),
                          h.el.setAttribute("y", (h.y - e / 2).toFixed(1)),
                          h.el.setAttribute(
                            "transform",
                            `rotate(${r.toFixed(1)} ${h.x.toFixed(1)} ${h.y.toFixed(1)})`,
                          ));
                      }
                      o.push(h);
                    }
                    u = o;
                  })(n);
                },
              };
            })({
              back: O.current,
              front: V.current,
              idPrefix: F,
              reduceMotion: t,
              radius: () => tE,
            }),
            ec = 0,
            eM = -1,
            ex = -1,
            ep = !1,
            eb = null,
            eg = q.reduce((t, e) => t + e.d, 0),
            ey = -1,
            ef = 0,
            eA = 0,
            em = 0,
            eE = 0,
            ew = 0,
            eF = 0,
            e_ = 0,
      /* ek() — start a bounce · eH(kind) — start a spin (dizzy / wild / bounce)
       * eP(t) — schedule a head "pulse" (double-blink style pop) */
            ek = () => {
              t || ey >= 0 || (ey = performance.now());
            },
            eC = null,
            ev = null,
            eH = (e) => {
              if (t || eC) return;
              let r = 0.5 > Math.random() ? 1 : -1,
                i =
                  "spinDizzy" === e
                    ? Math.round(v(3, 4))
                    : "spinWild" === e
                      ? 9
                      : 1;
              eC = { kind: e, t0: performance.now(), dir: r, turns: i };
            },
            e$ = Math.floor(v(0, 5)),
            eD = !1,
            eP = (t) => {
              (tG.push(
                { at: t, v: 0.05 },
                { at: t + 70, v: 0.05 },
                { at: t + 150, v: 1.08 },
                { at: t + 300, v: 1 },
              ),
                0.14 > Math.random() &&
                  tG.push({ at: t + 370, v: 0.05 }, { at: t + 480, v: 1 }));
            },
      /* eS — breathing / resonance envelope used by the ring effects */
            eS = (t, e) =>
              (0.42 +
                0.29 * Math.sin(0.0021 * t) * Math.sin(0.0034 * t) +
                0.29 * Math.sin(0.0013 * t + 1.7)) *
              (0.55 + 0.45 * Math.sin(0.012 * t - 1.05 * Math.abs(e))),
      /* eR — ring resonance: how strongly a ring effect pulses right now */
            eR = (e, r, i) => {
              let a = Math.abs(
                (((((e - tI) / 1400 + 0.119) % 1) + 1) % 1) - r / 3,
              );
              a = Math.min(a, 1 - a);
              let n = t ? 1 : Math.exp(-(a * a) / 0.045),
                s = +!t;
              return {
                lift: 9 * n * i * s,
                pop: 1 + s * (0.84 + 0.22 * n - 1),
                tone: 1 - 0.5 * s * (1 - n),
              };
            },
      /* ---- effect renderers (one per ring type) -------------------------------
       * eI dots · ej orbit · eN radar · eO progress · eB gather · eL wave ·
       * ez send · eV receive · eK dock · eG pencil · eX bang · eW standby —
       * each draws into the hidden circles/paths based on a 0..1 fade-in
       * factor and absolute time. */
            eI = (t, e) => {
              let r = [x.HEAD_C - 62, x.HEAD_C + 62];
              for (let i = 0; i < 2; i++) {
                let a = tl.current[i];
                if (!a) continue;
                let n = H((t - 0.12 * i) / (1 - 0.12 * i), 0, 1);
                if (n <= 0.004) {
                  a.style.display = "none";
                  continue;
                }
                let s = D(n),
                  l = P(n),
                  o = eR(e, 2 * (0 !== i), t),
                  u = ((22 * s * o.pop) / x.HEAD_C) * 1.02;
                ((a.style.display = ""),
                  a.setAttribute(
                    "transform",
                    `translate(${(x.HEAD_C + (r[i] - x.HEAD_C) * l).toFixed(1)} ${(x.HEAD_C - o.lift).toFixed(1)}) scale(${u.toFixed(4)}) translate(${-x.HEAD_C} ${-x.HEAD_C})`,
                  ),
                  a.setAttribute("opacity", (s * o.tone).toFixed(3)));
              }
            },
            ej = (t, e) => {
              let r = D(t),
                i = 52 * P(t),
                a = 0.0017 * e;
              for (let t = 0; t < 5; t++) {
                let e = th.current[t];
                if (!e) continue;
                let n = a + (t * Math.PI * 2) / 5,
                  s = Math.cos(n),
                  l = 0.5 + 0.5 * H(s, 0, 1);
                ((e.style.display = ""),
                  e.setAttribute("cx", (x.HEAD_C + i * Math.sin(n)).toFixed(1)),
                  e.setAttribute(
                    "cy",
                    (x.HEAD_C - 0.42 * i * Math.cos(n)).toFixed(1),
                  ),
                  e.setAttribute("r", Math.max(12 * l * r, 0.3).toFixed(2)),
                  e.setAttribute(
                    "opacity",
                    (H((s + 0.4) / 0.6, 0.18, 1) * r).toFixed(3),
                  ));
              }
            },
            eN = (t, e, r) => {
              let i = D(t);
              for (let t = 0; t < 3; t++) {
                let a = td.current[t];
                if (!a) continue;
                let n = (e / 1300 + t / 3) % 1;
                ((a.style.display = ""),
                  a.removeAttribute("stroke-dasharray"),
                  a.removeAttribute("transform"),
                  a.setAttribute("r", (r + (104 - r) * n).toFixed(1)),
                  a.setAttribute(
                    "stroke-width",
                    (3.4 * (1 - 0.55 * n)).toFixed(2),
                  ),
                  a.setAttribute("opacity", (i * (1 - n) * 0.9).toFixed(3)));
              }
            },
            eO = (t, e) => {
              let r = D(t),
                i = P(t),
                a = H((e - tv) / (y.progress ?? 2500), 0, 1),
                n = H(a / 0.85, 0, 1),
                s = td.current[3];
              s &&
                ((s.style.display = ""),
                s.setAttribute("r", (62 * i).toFixed(1)),
                s.setAttribute("stroke-width", "5"),
                s.removeAttribute("stroke-dasharray"),
                s.removeAttribute("transform"),
                s.setAttribute("opacity", (0.16 * r).toFixed(3)));
              let l = td.current[4];
              if (l) {
                let t = 62 * i,
                  e = 2 * Math.PI * t;
                ((l.style.display = ""),
                  l.setAttribute("r", t.toFixed(1)),
                  l.setAttribute("stroke-width", "5"),
                  l.setAttribute("stroke-dasharray", `${e.toFixed(1)}`),
                  l.setAttribute("stroke-dashoffset", (e * (1 - n)).toFixed(1)),
                  l.setAttribute(
                    "transform",
                    `rotate(-90 ${x.HEAD_C} ${x.HEAD_C})`,
                  ),
                  l.setAttribute("opacity", r.toFixed(3)));
              }
            },
            eB = (t, e) => {
              let r = D(t),
                i = y.spawning ?? 2e3;
              for (let t = 0; t < 5; t++) {
                let a = th.current[t];
                if (!a) continue;
                let n = H(((e - tv) / i - 0.09 * t) / 0.62, 0, 1);
                if (n >= 1) {
                  a.style.display = "none";
                  continue;
                }
                let s = 1 - Math.pow(1 - n, 3),
                  l = 2.4 * t + 2.2 * n,
                  o = 96 * (1 - s);
                ((a.style.display = ""),
                  a.setAttribute("cx", (x.HEAD_C + o * Math.cos(l)).toFixed(1)),
                  a.setAttribute(
                    "cy",
                    (x.HEAD_C + o * Math.sin(l) * 0.8).toFixed(1),
                  ),
                  a.setAttribute("r", (9 * (0.5 + 0.5 * s) * r).toFixed(2)),
                  a.setAttribute(
                    "opacity",
                    (r * H(5 * n, 0, 1) * (1 - 0.25 * s)).toFixed(3),
                  ));
              }
            },
            eL = (t, e) => {
              let r = [-2, -1, 1, 2];
              for (let i = 0; i < 4; i++) {
                let a = i < 2 ? tl.current[i] : th.current[i - 2];
                if (!a) continue;
                let n = r[i],
                  s = H(
                    (t - 0.1 * Math.abs(n)) / (1 - 0.1 * Math.abs(n)),
                    0,
                    1,
                  );
                if (s <= 0.004) {
                  a.style.display = "none";
                  continue;
                }
                let l = P(s),
                  o = eS(e, n),
                  u = (7 + 9 * H(o, 0.08, 1)) * D(s),
                  h = 6 * H(o, 0, 1) * s;
                if (((a.style.display = ""), i < 2)) {
                  let t = (u / x.HEAD_C) * 1.02;
                  (a.setAttribute(
                    "transform",
                    `translate(${(x.HEAD_C + 44 * n * l).toFixed(1)} ${(x.HEAD_C - h).toFixed(1)}) scale(${t.toFixed(4)}) translate(${-x.HEAD_C} ${-x.HEAD_C})`,
                  ),
                    a.setAttribute("opacity", s.toFixed(3)));
                } else
                  (a.setAttribute("cx", (x.HEAD_C + 44 * n * l).toFixed(1)),
                    a.setAttribute("cy", (x.HEAD_C - h).toFixed(1)),
                    a.setAttribute("r", u.toFixed(2)),
                    a.setAttribute("opacity", s.toFixed(3)));
              }
            },
            ez = (t, e) => {
              let r = D(t),
                i = ((((e - tM.current) / 1500) % 1) + 1) % 1,
                a = H((i - 0.18) / 0.55, 0, 1),
                n = a * a * (0.4 + 0.6 * a),
                s = 108 * n,
                l = th.current[0];
              if (l) {
                let t = a > 0 && a < 1;
                ((l.style.display = t ? "" : "none"),
                  t &&
                    (l.setAttribute("cx", (x.HEAD_C + 0.74 * s).toFixed(1)),
                    l.setAttribute("cy", (x.HEAD_C + -0.62 * s).toFixed(1)),
                    l.setAttribute("r", (10 * (1 - 0.55 * n) * r).toFixed(2)),
                    l.setAttribute("opacity", (r * (1 - n * n)).toFixed(3))));
              }
              let o = th.current[1];
              if (o) {
                let t = H((i - 0.26) / 0.55, 0, 1),
                  e = t * t * (0.4 + 0.6 * t),
                  n = a > 0 && t > 0 && t < 1;
                if (((o.style.display = n ? "" : "none"), n)) {
                  let t = 108 * e;
                  (o.setAttribute("cx", (x.HEAD_C + 0.74 * t).toFixed(1)),
                    o.setAttribute("cy", (x.HEAD_C + -0.62 * t).toFixed(1)),
                    o.setAttribute("r", (5 * (1 - 0.6 * e) * r).toFixed(2)),
                    o.setAttribute("opacity", (0.3 * r * (1 - e)).toFixed(3)));
                }
              }
              let u = td.current[0];
              if (u) {
                let t = H((i - 0.18) / 0.3, 0, 1),
                  e = t > 0 && t < 1;
                ((u.style.display = e ? "" : "none"),
                  e &&
                    (u.removeAttribute("stroke-dasharray"),
                    u.removeAttribute("transform"),
                    u.setAttribute("r", (20 + 34 * D(t)).toFixed(1)),
                    u.setAttribute("stroke-width", (2.8 * (1 - t)).toFixed(2)),
                    u.setAttribute("opacity", (r * (1 - t) * 0.8).toFixed(3))));
              }
            },
            eV = (t, e) => {
              let r = D(t),
                i = e - tM.current,
                a = Math.floor(i / 1700);
              a !== tQ &&
                ((tQ = a), (t1 = v(-(1.25 * Math.PI), 0.25 * Math.PI)));
              let n = (((i / 1700) % 1) + 1) % 1,
                s = H(n / 0.6, 0, 1),
                l = 1 - Math.pow(1 - s, 3),
                o = Math.cos(t1),
                u = Math.sin(t1),
                h = 108 * (1 - l),
                d = th.current[0];
              if (d) {
                let t = s < 1;
                if (((d.style.display = t ? "" : "none"), t)) {
                  let t = 18 * Math.sin(s * Math.PI) * (1 - 0.7 * l);
                  (d.setAttribute("cx", (x.HEAD_C + o * h + -u * t).toFixed(1)),
                    d.setAttribute("cy", (x.HEAD_C + u * h + o * t).toFixed(1)),
                    d.setAttribute("r", (3.5 + 6.5 * l).toFixed(2)),
                    d.setAttribute(
                      "opacity",
                      (r * H(3.5 * s, 0, 1) * (0.3 + 0.7 * l)).toFixed(3),
                    ));
                }
              }
              let c = td.current[1];
              if (c) {
                let t = H((n - 0.58) / 0.32, 0, 1),
                  e = t > 0 && t < 1;
                ((c.style.display = e ? "" : "none"),
                  e &&
                    (c.removeAttribute("stroke-dasharray"),
                    c.removeAttribute("transform"),
                    c.setAttribute("r", (20 + 26 * D(t)).toFixed(1)),
                    c.setAttribute("stroke-width", (2.8 * (1 - t)).toFixed(2)),
                    c.setAttribute("opacity", (r * (1 - t) * 0.8).toFixed(3))));
              }
            },
            eK = (t, e) => {
              let r = D(t),
                i = (e - tM.current) / 1e3;
              for (let t = 0; t < 2; t++) {
                let a = th.current[t];
                if (!a) continue;
                let n = H((i - (0.2 + 1.3 * t)) / 0.9, 0, 1);
                if (n <= 0) {
                  a.style.display = "none";
                  continue;
                }
                let s = 1 - Math.pow(1 - n, 3),
                  l = 0.001 * e * 1.1 + t * Math.PI,
                  o = x.HEAD_C + 42 * Math.sin(l),
                  u = x.HEAD_C + 21 * Math.cos(l) + 2 * Math.sin(0.003 * e + t),
                  h = x.HEAD_C - 120 + 30 * t,
                  d = x.HEAD_C + 95;
                ((a.style.display = ""),
                  a.setAttribute("cx", (h + (o - h) * s).toFixed(1)),
                  a.setAttribute("cy", (d + (u - d) * s).toFixed(1)),
                  a.setAttribute("r", ((7 + 3 * s) * r).toFixed(2)),
                  a.setAttribute("opacity", (r * H(4 * n, 0, 1)).toFixed(3)));
              }
            },
            eT = (t) => {
              let e = t - tM.current,
                r = (((e / 2500) % 1) + 1) % 1;
              if (r < 0.68) {
                let t = r / 0.68,
                  i = H(t / 0.08, 0, 1) * H((1 - t) / 0.08, 0, 1);
                return {
                  x: -54 + t * t * (3 - 2 * t) * 118,
                  y: 26,
                  wig: 3.2 * Math.sin(24 * t) * i,
                  rot: 17 + +Math.sin(6e-4 * e),
                  lift: !1,
                };
              }
              let i = $((r - 0.68) / 0.32);
              return {
                x: 64 - 118 * i,
                y: 26 - 20 * Math.sin(i * Math.PI),
                wig: 0,
                rot: 17 - 2 * Math.sin(i * Math.PI) + +Math.sin(6e-4 * e),
                lift: !0,
              };
            },
            eG = (t, e) => {
              let r = eT(e),
                i = tu.current[0];
              if (i) {
                let e = ((r.rot - 90) * Math.PI) / 180,
                  a = 68 * Math.cos(e),
                  n = 68 * Math.sin(e);
                ((i.style.display = ""),
                  i.setAttribute("d", G),
                  (i.style.fill = "var(--fg)"),
                  i.setAttribute(
                    "transform",
                    `translate(${(x.HEAD_C + (r.x + a) * t).toFixed(1)} ${(x.HEAD_C + (r.y + 0.15 * r.wig + n) * t).toFixed(1)}) rotate(${(r.rot * t).toFixed(1)}) scale(${D(t).toFixed(3)}) translate(${-x.HEAD_C} ${-x.HEAD_C})`,
                  ),
                  i.setAttribute("opacity", H(1.6 * t - 0.3, 0, 1).toFixed(3)));
              }
              if (t > 0.6 && !r.lift) {
                let t = x.HEAD_C + r.x,
                  e = x.HEAD_C + r.y + r.wig + 19,
                  i = tJ[tJ.length - 1];
                !i || Math.hypot(t - i[0], e - i[1]) > 2.4
                  ? (tJ.push([t, e]), tJ.length > 64 && tJ.shift())
                  : i && ((i[0] = t), (i[1] = e));
              } else tJ.length && tJ.splice(0, 2);
              let a = tu.current[1];
              a &&
                (tJ.length < 2
                  ? (a.style.display = "none")
                  : ((a.style.display = ""),
                    (a.style.fill = "none"),
                    (a.style.stroke = "var(--fg)"),
                    a.setAttribute("stroke-width", "6"),
                    a.setAttribute("stroke-linecap", "round"),
                    a.setAttribute("stroke-linejoin", "round"),
                    a.setAttribute(
                      "d",
                      ((t) => {
                        let e = t.length,
                          r = `M${t[0][0].toFixed(1)} ${t[0][1].toFixed(1)}`;
                        if (2 === e)
                          return (
                            r + `L${t[1][0].toFixed(1)} ${t[1][1].toFixed(1)}`
                          );
                        for (let i = 0; i < e - 1; i++) {
                          let a = t[Math.max(i - 1, 0)],
                            n = t[i],
                            s = t[i + 1],
                            l = t[Math.min(i + 2, e - 1)],
                            o = n[0] + (s[0] - a[0]) / 6,
                            u = n[1] + (s[1] - a[1]) / 6,
                            h = s[0] - (l[0] - n[0]) / 6,
                            d = s[1] - (l[1] - n[1]) / 6;
                          r += `C${o.toFixed(1)} ${u.toFixed(1)} ${h.toFixed(1)} ${d.toFixed(1)} ${s[0].toFixed(1)} ${s[1].toFixed(1)}`;
                        }
                        return r;
                      })(tJ),
                    ),
                    a.setAttribute("opacity", H(1.2 * t, 0, 1).toFixed(3))));
            },
            eX = (t, e) => {
              let r = tu.current[2];
              if (!r) return;
              let i = (e - tM.current) / 1e3,
                a = D(H(1.1 * t, 0, 1)),
                n = Math.exp(-((i % 2.2) * 5.5)),
                s = 2.2 * Math.sin(42 * i) * n;
              ((r.style.display = ""),
                r.setAttribute("d", X),
                (r.style.fill = "var(--fg)"),
                r.setAttribute(
                  "transform",
                  `translate(0 ${(-26 - (1 - a) * 70).toFixed(1)}) rotate(${s.toFixed(2)} ${x.HEAD_C} ${(x.HEAD_C - 74).toFixed(1)}) translate(${x.HEAD_C} ${x.HEAD_C}) scale(${H(1.2 * t, 0, 1).toFixed(3)}) translate(${-x.HEAD_C} ${-x.HEAD_C})`,
                ),
                r.setAttribute("opacity", H(1.5 * t - 0.2, 0, 1).toFixed(3)));
            },
            eW = (t, e) => {
              let r = D(t),
                i = th.current[4];
              if (i) {
                let t = 0.5 + 0.5 * Math.sin(0.0016 * e);
                ((i.style.display = ""),
                  i.setAttribute("cx", `${x.HEAD_C}`),
                  i.setAttribute("cy", `${x.HEAD_C}`),
                  i.setAttribute("r", (26 + 7 * t).toFixed(1)),
                  i.setAttribute("opacity", (r * (0.06 + 0.1 * t)).toFixed(3)));
              }
              let a = td.current[2];
              if (a) {
                let e = t < 0.995;
                ((a.style.display = e ? "" : "none"),
                  e &&
                    (a.removeAttribute("stroke-dasharray"),
                    a.removeAttribute("transform"),
                    a.setAttribute("r", (104 - 88 * r).toFixed(1)),
                    a.setAttribute("stroke-width", "2.4"),
                    a.setAttribute("opacity", ((1 - r) * 0.5).toFixed(3))));
              }
            },
      /* =====================================================================
       * THE PER-FRAME UPDATE — called with the rAF timestamp M every frame.
       * =====================================================================
       */
            eU = (M) => {
              let F = Math.min((M - t2) / 1e3, 0.1);
              ((t2 = M), (er = F));
        /* which ring effect does the current state want? (thinking->dots, ...) */
              let _ = L[tc.current] ?? null;
              _ !== tC && ((tC = _), (tv = M), (tH = !1));
              let D = null != _,
                P = tc.current;
              (_ &&
                g.has(P) &&
                (!tH && M - tv > (y[P] ?? 2500)
                  ? ((tH = !0), (t$ = M))
                  : tH && M - t$ > 1500 && ((tH = !1), (tv = M)),
                (D = !tH)),
                (tw.t = +!!D),
                _ &&
                  _ !== t_ &&
                  (t_ && tw.x > 0.02
                    ? ((tk = t_),
                      (tF.x = 0),
                      (tF.v = 0),
                      (tF.t = 1),
                      t && (tF.x = 1))
                    : ((tk = null), (tF.x = 1), (tF.v = 0), (tF.t = 1)),
                  (t_ = _),
                  (tI = M)),
                !_ && tw.x < 0.004 && ((t_ = null), (tk = null)),
                tF.x > 0.996 && (tk = null),
                D !== tR &&
                  (D && !t && (tS = 0.5 > Math.random() ? 1 : -1),
                  t || (tD.t = tP += tj * tS),
                  (tR = D)),
        /* reduced motion: jump straight to a fixed expression */
                t
                  ? (t8(f[tc.current][0]),
                    (n.t = 0),
                    (s.t = 0),
                    (l.t = 0),
                    (o.t = 1),
                    (u.t = 1),
                    (h.t = 1))
                  : ((t) => {
                      let e = tc.current,
                        r = (t - t3) / 1e3,
                        M = (t - tM.current) / 1e3;
                      if (
                        (tN !== e &&
                          ((tN = e),
                          (tT = 0),
                          (tB = t + v(...A[e])),
                          (tL = t + v(1500, 7e3)),
                          (tX =
                            t +
                            ("excited" === e
                              ? v(400, 1100)
                              : "searching" === e
                                ? v(800, 1600)
                                : "working" === e
                                  ? v(1200, 2400)
                                  : v(6e3, 1e4))),
                          (tW = t + v(500, 1200)),
                          (tV = t + v(1200, 2200)),
                          (tK = 0),
                          (b = t + v(500, 1400)),
                          (Y = t + v(3e3, 8e3)),
                          (tU = -1),
                          (tQ = -1),
                          (tJ = []),
                          (eh = !1),
                          "celebrate" === e && (tO = t + 140),
                          "waking" !== e &&
                            "sleeping" !== e &&
                            ("drowsy" !== e && eP(t),
                            t8(f[e][0], "excited" === e ? 10 : 8))),
                        "celebrate" === e &&
                          !eC &&
                          t >= tO &&
                          (eH("spinWild"), (tO = t + 6200)),
                        t >= eu)
                      ) {
                        let r = E.has(e),
                          i = w.has(e);
                        if ((r || i) && !t7 && ey < 0 && !eC) {
                          let t = Math.random();
                          r
                            ? t < 0.55
                              ? eo(1)
                              : eH("spinBounce")
                            : t < 0.34
                              ? eH("spinBounce")
                              : t < 0.62
                                ? ek()
                                : t < 0.86
                                  ? eH("spinDizzy")
                                  : eo(1);
                        }
                        eu = t + v(9e3, 18e3);
                      }
        /* ---- per-state motion ------------------------------------------------
         * Every case sets spring targets n / s / l / o / u / h (head tilt,
         * eye tilt, eye-lid height, scale, squash, ...) as sine combinations
         * of elapsed time r; the springs smooth them into organic motion. */
                      let x = 1,
                        p = 1;
                      switch (e) {
                        case "sleeping": {
                          f.sleeping.includes(a)
                            ? (x = i.x > 0.85 ? 1 : 0.08)
                            : M < 1.2
                              ? (x = Math.max(
                                  0.08,
                                  1 -
                                    Math.min(1, M / 1) *
                                      (1 + 0.15 * Math.sin(6.5 * M)),
                                ))
                              : ((x = 0.08), u.x < 0.18 && t8(13, 11));
                          let t = Math.min(M / 2, 1),
                            e = Math.sin(H(M / 0.5, 0, 1) * Math.PI);
                          ((n.t = 0 + 4 * t + 2 * Math.sin(0.25 * r)),
                            (s.t = -2 * t),
                            (l.t = 8 * t + 3 * Math.sin(0.55 * r) - 5 * e),
                            (o.t = 1 + 0.016 * Math.sin(0.55 * r) + 0.05 * e));
                          break;
                        }
            /* waking: 0-0.5s eyes squint -> 0.5-1.2s pop open + confetti burst
             * -> settle; after 2.2s a subtle look around */
                        case "waking":
                          if (M < 0.5) ((x = 0.07), t8(3, 12), (l.t = 6));
                          else if (M < 1.2)
                            ((x = 1),
                              (p = 1.12),
                              (l.t = -5),
                              (s.t = 0),
                              (n.t = 0),
                              (o.t = 1.04),
                              eh || (ed.burst(v(9, 13), 0.8), (eh = !0)));
                          else if (M < 2.2)
                            (0 === tG.length && M < 1.4 && eP(t),
                              t8(0),
                              (l.t = 0),
                              (o.t = 1));
                          else {
                            let t = Math.min((M - 2.2) / 0.8, 1);
                            (t8(0),
                              (n.t =
                                0 + 6 * Math.sin(t * Math.PI * 3) * (1 - t)),
                              (l.t = 2 * Math.sin(0.9 * r)));
                          }
                          break;
                        case "idle":
                          ((n.t =
                            0 +
                            1.5 * Math.sin(0.5 * r) +
                            0.6 * Math.sin(0.17 * r)),
                            (s.t = +Math.sin(0.27 * r)),
                            (l.t = 1.2 * Math.sin(0.85 * r)),
                            (o.t = 1 + 0.007 * Math.sin(0.85 * r)));
                          break;
                        case "listening":
                          if (
                            ((n.t = 8 + 1.5 * Math.sin(0.5 * r)),
                            (s.t = 2),
                            (l.t = -2 + 0.8 * Math.sin(0.8 * r)),
                            (o.t = 1.015),
                            t >= tV &&
                              ((tz = t + 380), (tV = t + v(1800, 3200))),
                            t < tz)
                          ) {
                            let e = 1 - (tz - t) / 380;
                            ((l.t += 4.5 * Math.sin(e * Math.PI)),
                              (n.t += 2 * Math.sin(e * Math.PI)));
                          }
                          break;
                        case "thinking":
                          ((n.t = -9 + 5 * Math.sin(0.35 * r)),
                            (s.t = 5 * Math.sin(0.3 * r)),
                            (l.t = 2.5 * Math.sin(0.6 * r)),
                            (o.t = 1));
                          break;
                        case "searching": {
                          let e = Math.sin(1.3 * r);
                          ((n.t = 0 + 13 * e),
                            (s.t = 7 * e),
                            (l.t = 3 * Math.sin(1.7 * r)),
                            (o.t = 1),
                            t >= tX && (eo(), (tX = t + v(4e3, 7e3))));
                          break;
                        }
                        case "working": {
                          let e = Math.sin(r * Math.PI * 3.2);
                          ((n.t = 4 + 2.5 * e),
                            (s.t = 3),
                            (l.t = 1.5 + 3 * Math.max(0, e)),
                            (o.t = 1 - 0.02 * Math.max(0, e)),
                            t >= tX && (eo(1, 1), (tX = t + v(6e3, 9e3))));
                          break;
                        }
                        case "excited": {
                          let e = (2.2 * r) % 1;
                          ((l.t = -(10 * Math.sin(e * Math.PI)) + 2),
                            (o.t = e < 0.1 ? 0.92 : e < 0.3 ? 1.05 : 1),
                            (s.t = 4 * Math.sin(1.1 * r)),
                            (p = 1.06),
                            t >= tX && (eo(1), (tX = t + v(2800, 5e3))),
                            (n.t = 0 + 7 * Math.sin(r * Math.PI * 2.2)));
                          break;
                        }
                        case "surprised": {
                          let t = Math.min(M / 1.2, 1);
                          ((s.t = -4 * (1 - t)),
                            (l.t = -8 * (1 - t)),
                            (o.t = M < 0.2 ? 1.08 : 1),
                            (p = 1.15 - 0.08 * t),
                            (n.t = 0 + 1.5 * Math.sin(11 * r) * (1 - t)));
                          break;
                        }
                        case "suspicious":
                          ((n.t = -6 + 3 * Math.sin(0.3 * r)),
                            (s.t = -4 * Math.sin(0.25 * r)),
                            (l.t = 1 + 1.2 * Math.sin(0.45 * r)),
                            (o.t = 1),
                            (x = 0.85),
                            t >= tW && ((n.v += 30), (tW = t + v(4e3, 7e3))));
                          break;
                        case "angry":
                          (t >= tW &&
                            ((t0 = t + 420),
                            (l.v += 70),
                            (tW = t + v(1800, 3200))),
                            (n.t = 0 + (t < t0 ? 4.5 * Math.sin(0.05 * t) : 0)),
                            (s.t = 0),
                            (l.t = 3.5),
                            (o.t = 0.975));
                          break;
                        case "drowsy":
                          if (
                            ((n.t = 0 + 2.5 * Math.sin(0.32 * r)),
                            (s.t = 1.5 * Math.sin(0.2 * r)),
                            (l.t = 6 + 2.2 * Math.sin(0.36 * r)),
                            (o.t = 1 + 0.022 * Math.sin(0.36 * r)),
                            (x = 0.34 + 0.07 * Math.sin(0.8 * r)),
                            t >= tV && !tK && (tK = t),
                            tK)
                          ) {
                            let e = (t - tK) / 1e3;
                            if (e < 1.7) {
                              let t = e / 1.7,
                                r = t * t;
                              ((l.t =
                                6 +
                                19 * r +
                                2.2 * Math.sin(t * Math.PI * 2.5) * (1 - t)),
                                (n.t = 0 + 10 * r),
                                (x = 0.34 - r * (0.34 - 0.04)),
                                (o.t = 1 - 0.045 * r));
                            } else if (e < 2) {
                              let t = Math.sin(((e - 1.7) / 0.3) * Math.PI);
                              ((l.t = 25 - 7 * t),
                                (n.t = 10 - 4 * t),
                                (x = 0.04 + 0.42 * t));
                            } else if (e < 3.5) {
                              let t = (e - 1.7 - 0.3) / 1.5,
                                r = 1 - Math.pow(1 - t, 2.2);
                              ((l.t = 25 + -19 * r),
                                (n.t = 0 + 10 * (1 - r)),
                                (x = 0.46 + -0.12 * r),
                                t > 0.32 && t < 0.46 && (x = 0.05));
                            } else ((tK = 0), (tV = t + v(1500, 3500)));
                          }
                          break;
            /* happy: eyes squeeze into arcs and bob (|sin| envelope) */
                        case "happy": {
                          let t = Math.sin(2.4 * r);
                          ((n.t = 0 + 3 * Math.sin(1.2 * r)),
                            (s.t = 2.5 * Math.sin(1.1 * r)),
                            (l.t = -(3 * Math.abs(t))),
                            (o.t = 1 + 0.02 * t),
                            (p = 1.05));
                          break;
                        }
            /* curious: eyes widen, look side to side, occasional tilt */
                        case "curious":
                          if (
                            ((n.t = 10 + 6 * Math.sin(0.7 * r)),
                            (s.t = 5 * Math.sin(0.6 * r)),
                            (l.t = -2 + 1.5 * Math.sin(0.9 * r)),
                            (o.t = 1.01),
                            (p = 1.08),
                            t >= tV &&
                              ((tz = t + 440), (tV = t + v(1600, 2800))),
                            t < tz)
                          ) {
                            let e = 1 - (tz - t) / 440;
                            ((s.t += 8 * Math.sin(e * Math.PI)),
                              (n.t += 5 * Math.sin(e * Math.PI)));
                          }
                          break;
                        case "confused": {
                          let e = Math.sin(0.8 * r);
                          ((n.t = 0 + 12 * e),
                            (s.t = 3 * e),
                            (l.t = 2 * Math.sin(0.5 * r)),
                            (o.t = 1),
                            (x = 0.9),
                            t >= tW && ((n.v += 22), (tW = t + v(2600, 4200))));
                          break;
                        }
                        case "bored":
                          if (
                            ((n.t = -3 + 4 * Math.sin(0.25 * r)),
                            (s.t = 4 * Math.sin(0.2 * r)),
                            (l.t = 5 + 1.5 * Math.sin(0.35 * r)),
                            (o.t = 0.99),
                            (x = 0.6),
                            (p = 0.98),
                            t >= tW && ((tz = t + 600), (tW = t + v(4e3, 7e3))),
                            t < tz)
                          ) {
                            let e = 1 - (tz - t) / 600;
                            ((o.t = 1 + 0.05 * Math.sin(e * Math.PI)),
                              (l.t += 3 * Math.sin(e * Math.PI)));
                          }
                          break;
                        case "proud":
                          ((n.t = 0 + 2.5 * Math.sin(0.4 * r)),
                            (s.t = 2 * Math.sin(0.35 * r)),
                            (l.t = -4 + Math.sin(0.6 * r)),
                            (o.t = 1.03),
                            (p = 1.02),
                            (x = 0.9));
                          break;
                        case "shy":
                          ((n.t = -8 + 3 * Math.sin(0.5 * r)),
                            (s.t = -3 + 2 * Math.sin(0.4 * r)),
                            (l.t = 3),
                            (o.t = 0.98),
                            (p = 0.95),
                            (x = 0.85));
                          break;
                        case "sad":
                          ((n.t = 3 + 2 * Math.sin(0.3 * r)),
                            (s.t = 1.5 * Math.sin(0.25 * r)),
                            (l.t = 7 + Math.sin(0.4 * r)),
                            (o.t = 0.97),
                            (x = 0.7),
                            (p = 0.97));
                          break;
                        case "laughing": {
                          let t = Math.sin(r * Math.PI * 6.4);
                          ((n.t = 0 + 4 * t),
                            (s.t = 2 * Math.sin(2 * r)),
                            (l.t = -(5 * Math.abs(t))),
                            (o.t = 1 + 0.03 * t),
                            (x = 0.7),
                            (p = 1));
                          break;
                        }
                        case "scared":
                          ((n.t = 0 + 2 * Math.sin(0.04 * t)),
                            (s.t = -2 + 1.5 * Math.sin(0.05 * t)),
                            (l.t = 2 + Math.sin(1.5 * r)),
                            (o.t = 0.97),
                            (p = 1.12),
                            (x = 1.05));
                          break;
                        case "playful":
                          ((n.t = 0 + 8 * Math.sin(1.4 * r)),
                            (s.t = 4 * Math.sin(1.1 * r)),
                            (l.t = -(3 * Math.abs(Math.sin(2.2 * r)))),
                            (o.t = 1 + 0.015 * Math.sin(2.2 * r)),
                            (p = 1.06),
                            t >= tX && (eo(1), (tX = t + v(3500, 6e3))));
                          break;
                        case "celebrate":
                          ((n.t = 0),
                            (s.t = 0),
                            (l.t = -(2.5 * Math.abs(Math.sin(1.6 * r)))),
                            (o.t = 1),
                            (p = 1.1),
                            (x = 1.1));
                          break;
                        case "orbit":
                        case "radar":
                        case "progress":
                        case "spawning":
                        case "loading":
                        case "dictating":
                        case "sending":
                        case "receiving":
                        case "uploading":
                        case "writing":
                        case "alerting":
                        case "bouncing":
                        case "powering-down":
                          ((n.t = 0), (s.t = 0), (l.t = 0), (o.t = 1));
                          break;
                        case "dragging": {
                          let t = (M % 3.4) / 3.4,
                            e = Math.floor(M / 3.4);
                          (t < 0.12
                            ? ((s.t = -16), (l.t = -22), (n.t = -5))
                            : t < 0.62
                              ? ((s.t = -16 + 32 * $((t - 0.12) / 0.5)),
                                (l.t = -22 + 2 * Math.sin(1.4 * r)),
                                (n.t = 0 + 6 * Math.sin(2.6 * r)),
                                (p = 1.06))
                              : (e !== tU && ((tU = e), (l.v += 90)),
                                (s.t = 16),
                                (l.t = 0),
                                (n.t = 0)),
                            (o.t = 1));
                          break;
                        }
                        case "humming":
                          ((n.t = 0 + 2 * Math.sin(0.4 * r)),
                            (s.t = 1.5 * Math.sin(0.3 * r)),
                            (l.t = 1.5 * Math.sin(0.7 * r)),
                            (o.t = 1));
                          break;
                        case "notifying":
                          (tU < 0 && M > 0.12 && ((tU = 0), (l.v -= 26), eP(t)),
                            (p = 1 + 0.05 * Math.exp(-(3 * M))),
                            (n.t = 3),
                            (s.t = 2),
                            (l.t = -1),
                            (o.t = 1));
                      }
        /* ---- gaze wander -----------------------------------------------------
         * every so often pick a random eyeball direction (i, a) so the bot
         * never stares dead ahead */
                      if (t >= b) {
                        let r = () => (0.5 > Math.random() ? -1 : 1),
                          i = 0,
                          a = 0,
                          n = 2500,
                          s = 5e3;
                        switch (e) {
                          case "idle":
                            ((i = 0), (a = 0), (n = 2500), (s = 5500));
                            break;
                          case "listening":
                            ((i = 15 * v(-0.3, 0.3)),
                              (a = 9 * v(-0.25, 0.25)),
                              (n = 2200),
                              (s = 4200));
                            break;
                          case "thinking":
                            ((i = r() * v(0.5, 1) * 15),
                              (a = -(9 * v(0.4, 1))),
                              (n = 1500),
                              (s = 2800));
                            break;
                          case "searching":
                            ((i = r() * v(0.7, 1) * 15),
                              (a = 9 * v(-1, 1)),
                              (n = 550),
                              (s = 1150));
                            break;
                          case "working":
                            ((i = 15 * v(-0.4, 0.4)),
                              (a = 9 * v(0.4, 1)),
                              (n = 1200),
                              (s = 2400));
                            break;
                          case "excited":
                            ((i = 15 * v(-1, 1)),
                              (a = 9 * v(-1, 0.3)),
                              (n = 700),
                              (s = 1400));
                            break;
                          case "surprised":
                            ((i = 0), (a = 0), (n = 1600), (s = 2600));
                            break;
                          case "suspicious":
                            ((i = 15 * r()),
                              (a = 2.6999999999999997),
                              (n = 2200),
                              (s = 4200));
                            break;
                          case "angry":
                            ((i = 15 * v(-0.2, 0.2)),
                              (a = 1.8),
                              (n = 1800),
                              (s = 3200));
                            break;
                          case "drowsy":
                            ((i = 15 * v(-0.4, 0.4)),
                              (a = 9 * v(0.4, 1)),
                              (n = 2500),
                              (s = 4500));
                            break;
                          case "happy":
                            ((i = 15 * v(-0.7, 0.7)),
                              (a = -(9 * v(0, 0.6))),
                              (n = 1800),
                              (s = 3400));
                            break;
                          case "curious":
                            ((i = r() * v(0.6, 1) * 15),
                              (a = 9 * v(-1, 1)),
                              (n = 950),
                              (s = 1900));
                            break;
                          case "confused":
                            ((i = r() * v(0.5, 1) * 15),
                              (a = 9 * v(-0.6, 1)),
                              (n = 1100),
                              (s = 2300));
                            break;
                          case "bored":
                            ((i = r() * v(0.7, 1) * 15),
                              (a = 9 * v(0.4, 0.9)),
                              (n = 3e3),
                              (s = 6e3));
                            break;
                          case "proud":
                            ((i = 15 * v(-0.3, 0.3)),
                              (a = -(9 * v(0.3, 0.7))),
                              (n = 2600),
                              (s = 4600));
                            break;
                          case "shy":
                            ((i = r() * v(0.6, 1) * 15),
                              (a = 9 * v(0.5, 1)),
                              (n = 2e3),
                              (s = 4e3));
                            break;
                          case "sad":
                            ((i = 15 * v(-0.3, 0.3)),
                              (a = 9 * v(0.6, 1)),
                              (n = 2800),
                              (s = 5e3));
                            break;
                          case "laughing":
                            ((i = 15 * v(-0.5, 0.5)),
                              (a = -(9 * v(0.2, 0.6))),
                              (n = 800),
                              (s = 1700));
                            break;
                          case "scared":
                            ((i = r() * v(0.7, 1) * 15),
                              (a = 9 * v(-0.6, 0.6)),
                              (n = 450),
                              (s = 1050));
                            break;
                          case "playful":
                            ((i = r() * v(0.5, 1) * 15),
                              (a = -(9 * v(0, 0.6))),
                              (n = 900),
                              (s = 1800));
                            break;
                          case "notifying": {
                            let t = 0.72 > Math.random();
                            ((i = (t ? 0.45 : 0.1) * 15),
                              (a = -(9 * (t ? 0.3 : 0.05))),
                              (n = 1200),
                              (s = 2400));
                            break;
                          }
                          default:
                            ((i = 15 * v(-0.4, 0.4)), (a = 9 * v(-0.3, 0.3)));
                        }
                        ((d.t = i), (c.t = a), (b = t + v(n, s)));
                      }
                      if (
                        (("idle" === e ||
                          "happy" === e ||
                          "excited" === e ||
                          "curious" === e ||
                          "playful" === e) &&
                          t >= Y &&
                          ((tx = t),
                          (tp = 0.5 > Math.random() ? 0 : 1),
                          (Y = t + v(4500, 1e4))),
                        (ev = null),
                        (eA = 0),
                        (em = 0),
                        (eE = 0),
                        (ew = 0),
                        (eF = 0),
                        (e_ = 0),
                        eC)
                      ) {
                        let e = (t - eC.t0) / 1e3,
                          { kind: r, dir: i, turns: a } = eC;
                        if ("spinDizzy" === r) {
                          let t = 0.55 + 0.16 * a;
                          if (e < t) {
                            let r = e / t;
                            ev = a * Math.PI * 2 * i * (r * r);
                          } else if (e < t + 1.5) {
                            let r = e - t,
                              a = Math.pow(1 - r / 1.5, 1.3);
                            ((eA = 17 * Math.sin(10 * r) * i * a),
                              (em = 10 * Math.cos(10 * r) * i * a),
                              (eE = 3 * Math.sin(20 * r) * a),
                              (x = 0.46 + 0.14 * Math.sin(21 * r)),
                              (p = 1.03));
                          } else eC = null;
                        } else if ("spinWild" === r) {
                          let t = 2.3 - 0.3,
                            r = 2 * Math.PI,
                            n = (a * r + 0.5) / (0.15 + (2.3 - 0.3) + 0.3125);
                          if (e < 5.49) {
                            let s;
                            if (e < 0.24)
                              s =
                                (-0.5 * (1 - Math.cos((e / 0.24) * Math.PI))) /
                                2;
                            else if (e < 0.54) {
                              let t = e - 0.24;
                              s = -0.5 + (n * t * t) / 0.6;
                            } else
                              s =
                                e < 2.54
                                  ? -0.5 + n * (0.15 + (e - 0.24 - 0.3))
                                  : e < 3.79
                                    ? -0.5 +
                                      n * (0.15 + t) +
                                      (1.25 *
                                        n *
                                        (1 -
                                          Math.pow(
                                            1 - (e - 0.24 - 2.3) / 1.25,
                                            4,
                                          ))) /
                                        4
                                    : a * r;
                            ev = s * i;
                            let l = 0;
                            if (e > 2.54) {
                              let t = Math.min((e - 0.24 - 2.3) / 1.25, 1);
                              ((l = t < 0.4 ? 0 : Math.pow((t - 0.4) / 0.6, 2)),
                                e >= 3.79 &&
                                  (l = Math.pow(1 - (e - 3.79) / 1.7, 1.6)));
                            }
                            let o = Math.max(e - 0.24 - 2.3, 0);
                            ((ew = (s / (a * r)) * 1080 * i),
                              (eA = 11 * Math.sin(9.2 * o) * i * l),
                              (em = (Math.cos(9.2 * o) - 1) * 6 * i * l),
                              (eE = 2.6 * Math.sin(18.4 * o) * l),
                              (eF = 13 * Math.sin(11.5 * o) * i * l),
                              (e_ = (Math.cos(9 * o) - 1) * 3.5 * l),
                              (x =
                                1.14 - 0.44 * l + 0.1 * Math.sin(16 * o) * l),
                              (p = 1.12 - 0.09 * l));
                          } else eC = null;
                        } else
                          "spinBounce" === r &&
                            (e < 0.7
                              ? (ev = a * Math.PI * 2 * i * $(e / 0.7))
                              : (ek(), (eC = null)));
                      }
                      if (((ef = 0), ey >= 0)) {
                        let e = (t - ey) / 1e3;
                        if (e >= eg) ey = -1;
                        else {
                          let t = 0,
                            r = 0;
                          for (; r < q.length && !(e < t + q[r].d); r++)
                            t += q[r].d;
                          let { h: i, d: a } = q[r],
                            n = (e - t) / a;
                          ef = -4 * i * n * (1 - n);
                        }
                      }
                      if ("waking" !== e && "sleeping" !== e && t >= tB) {
                        let r = f[e];
                        ((tT =
                          (tT + 1 + Math.floor(v(0, r.length - 1))) % r.length),
                          t8(
                            r[tT],
                            "searching" === e || "excited" === e ? 10 : 6,
                          ),
                          (tB = t + v(...A[e])));
                      }
                      let g = m[e];
                      g && t >= tL && (eP(t), (tL = t + v(g[0], g[1])));
                      let y = null;
                      for (; tG.length && t >= tG[0].at;)
                        ((y = tG[0].v), tG.shift());
                      ((u.t = y ?? (tG.length ? u.t : x)), (h.t = p));
                    })(M),
                Q.current &&
                  ((h.t = Math.max(h.t, 1.32)), (u.t = Math.max(u.t, 1.18))));
              let I = Math.max(1, Math.ceil(F / C)),
                j = F / I;
              for (let t = 0; t < I; t++)
                (k(i, t9, 1, j),
                  t7 && k(t7, 6.2, 1, j),
                  k(n, 5, 0.9, j),
                  k(s, 3.5, 1, j),
                  k(l, 4, 1, j),
                  k(o, 10, 0.8, j),
                  k(u, 26, 1, j),
                  k(h, 9, 0.85, j),
                  k(tZ, 9, 0.55, j),
                  k(tY, 6, 1, j),
                  k(d, 13, 1, j),
                  k(c, 13, 1, j),
                  k(tw, 14, 1, j),
                  k(tF, 11, 1, j),
                  k(tb, 10, 1, j),
                  k(tD, 14, 1, j));
              (t && ((tF.x = 1), (tD.x = tD.t), (tw.x = tw.t)),
                ((a) => {
                  let M = Math.min(Math.max(i.x, 0), 1),
                    b = 0,
                    g = !1;
                  (t7 &&
                    ((b = t7.x),
                    (g = !0),
                    0.004 > Math.abs(t7.t - t7.x) &&
                      0.015 > Math.abs(t7.v) &&
                      ((t7 = null), (eD = !1), (b = 0), (g = !1))),
                    (ee += (!!Q.current - ee) * el(0.12)));
                  let y = [
                      (0, x.lerpRing)(e[0], r[0], M),
                      (0, x.lerpRing)(e[1], r[1], M),
                    ],
                    f = [(0, x.centroid)(y[0]), (0, x.centroid)(y[1])],
                    A = (f[0][0] + f[1][0]) / 2,
                    m = (f[0][1] + f[1][1]) / 2,
                    E = (x.HEAD_C - A) * 0.42 * ee,
                    w = (x.HEAD_C - m) * 0.42 * ee,
                    F = tw.x > 0.001 || Math.abs(tD.t - tD.x) > 0.01;
                  null !== ev && ((b += ev), (g = !0));
                  let _ = F ? tD.x : null;
                  _ = g ? (_ ?? 0) + b : _;
                  let k = p.SHAPES[ti.current];
                  if (ti.current !== tg) {
                    let e = $(H(tb.x, 0, 1)),
                      r = p.SHAPES[tg];
                    ((ty = e >= 1 ? r.ring : (0, x.lerpRing)(ty, r.ring, e)),
                      (tf = e >= 1 ? r.face : W(tf, r.face, e)),
                      (tA += (r.tiltScale - tA) * e),
                      (tm += (r.beltRadius - tm) * e),
                      (tg = ti.current),
                      (tb.x = 0),
                      (tb.v = 0),
                      (tb.t = 1),
                      t ||
                        ((eD = !1),
                        0 == (e$ = (e$ + 1) % 5)
                          ? eo(1)
                          : 1 === e$
                            ? ((eD = !0), eo(2))
                            : 2 === e$
                              ? eH("spinBounce")
                              : 3 === e$
                                ? eH("spinDizzy")
                                : (eo(1), ed.burst(16, 0.95, 0.3))));
                  }
                  let C = $(H(tb.x, 0, 1)),
                    v = C < 0.999,
                    D = v ? (0, x.lerpRing)(ty, k.ring, C) : k.ring,
                    P = v ? W(tf, k.face, C) : k.face,
                    I = v ? tA + (k.tiltScale - tA) * C : k.tiltScale;
                  ((tE = v ? tm + (k.beltRadius - tm) * C : k.beltRadius),
                    "loading" === tc.current &&
                      (tE += (52 - tE) * H(tw.x, 0, 1)));
                  let j = D[Math.round((7 * D.length) / 8) % D.length],
                    O = !1;
                  g && !v && k.turnAt && ((D = k.turnAt(b)), (O = !0));
                  let L = k.top,
                    V = k.bottom;
                  if (v || O)
                    for (let t of ((L = 1 / 0), (V = -1 / 0), D))
                      (t[1] < L && (L = t[1]), t[1] > V && (V = t[1]));
                  let G =
                      v || O
                        ? (t) =>
                            ((t, e) => {
                              let r = -1 / 0,
                                i = 1 / 0;
                              for (let a = 0; a < t.length; a++) {
                                let n = t[a],
                                  s = t[(a + 1) % t.length];
                                if (n[1] <= e == s[1] <= e) continue;
                                let l =
                                  n[0] +
                                  ((s[0] - n[0]) * (e - n[1])) / (s[1] - n[1]);
                                l <= x.HEAD_C
                                  ? l > r && (r = l)
                                  : l < i && (i = l);
                              }
                              return (
                                (U[0] = Number.isFinite(r) ? r : x.HEAD_C),
                                (U[1] = Number.isFinite(i) ? i : x.HEAD_C),
                                U
                              );
                            })(D, t)
                        : k.spanAt,
                    X = 0,
                    q = 0;
                  for (let t of y[0]) X = Math.max(X, Math.abs(t[0] - f[0][0]));
                  for (let t of y[1]) q = Math.max(q, Math.abs(t[0] - f[1][0]));
                  let Y = Math.abs(f[1][0] - f[0][0]) * P.sx,
                    tr = X + q > 0.5 ? H((Y - 5) / (X + q), 0.35, 4) : 4;
                  for (let t = 0; t < 2; t++) {
                    let e = ts.current[t];
                    if (!e) continue;
                    let [r, i] = f[t],
                      n = Math.max(u.x, 0.04);
                    if (t === tp && a < tx + 320) {
                      let t = (a - tx) / 320;
                      n = Math.max(
                        n * (t < 0.42 ? 1 - t / 0.42 : (t - 0.42) / 0.58),
                        0.04,
                      );
                    }
                    let s = y[t];
                    e.setAttribute("d", (0, x.ringPath)(s));
                    let l = x.HEAD_C + P.x,
                      o = (r - x.HEAD_C) * P.sx,
                      p = 1,
                      b = !0,
                      g = 1;
                    if (null !== _) {
                      let [t, e] = G(
                          H(
                            x.HEAD_C + P.y + (i - x.HEAD_C) * P.sy,
                            L + 2,
                            V - 2,
                          ),
                        ),
                        r = Math.max((e - t) / 2, 12);
                      l = (t + e) / 2;
                      let a = Math.asin(H(o / r, -1, 1)),
                        n = a + _,
                        s = Math.cos(n),
                        u = Math.max(Math.cos(a), 0.02);
                      ((b = s > 0.02),
                        (p = Math.max(s, 0.02) / u),
                        (o = r * Math.sin(n)),
                        (g = S(H(s / 0.5, 0, 1))));
                    }
                    let A = 1 + 0.07 * Math.sin(M * Math.PI),
                      m =
                        1.4 * Math.sin(42e-5 * a + t) +
                        0.5 * Math.sin(0.001 * a + 2 * t),
                      F = 0.9 * Math.sin(58e-5 * a + t),
                      k = Z.current;
                    if (k && R.current) {
                      (!t4 || a - t6 > 200) &&
                        ((t4 = R.current.getBoundingClientRect()), (t6 = a));
                      let t = t4,
                        e = J.current ? -1 : 1;
                      ((et.tx =
                        22 *
                        H((k.x - (t.left + t.width / 2)) / t.width, -0.6, 0.6) *
                        e),
                        (et.ty =
                          14 *
                          H(
                            (k.y - (t.top + t.height / 2)) / t.height,
                            -0.6,
                            0.6,
                          )));
                    } else ((et.tx = 0), (et.ty = 0));
                    let C = el(0.09);
                    ((et.x += (et.tx - et.x) * C),
                      (et.y += (et.ty - et.y) * C),
                      (m += et.x * (1 - 0.6 * ee) + E),
                      (F += et.y * (1 - 0.6 * ee) + w));
                    let v = k ? 0.2 : 1;
                    ((m += d.x * v + eF), (F += c.x * v + e_));
                    let $ = H(tZ.x, 0, 1);
                    ((m -= 10 * $), (F += 7 * $));
                    let D = Math.min(H(h.x, 0.2, 2) * P.eye, tr / A),
                      I = H(p * D * A, 0.02, 2.4),
                      N = H(n * D * A, 0.02, 2.4);
                    e.style.display = b && tw.x < 0.5 ? "" : "none";
        /* ---- render the eyes ------------------------------------------------
         * project both eye rings, clamp them inside the head outline
         * (spanAt), add gaze + drift, and write each eye's transform.
         * The translate/scale-around-eye-centre matrix is what makes the
         * eyes look around inside the head. */
                    let O = x.EYE_HALF * N + 2,
                      B = H(
                        x.HEAD_C + P.y + (i + F - x.HEAD_C) * P.sy,
                        L + O,
                        V - O,
                      ),
                      z = -1 / 0,
                      K = 1 / 0;
                    for (let t = 0; t < s.length; t += 2) {
                      let e = (s[t][0] - r) * I,
                        [a, n] = G(B + (s[t][1] - i) * N);
                      (a - e > z && (z = a - e), n - e < K && (K = n - e));
                    }
                    let T = l + o + m * P.sx,
                      W = z <= K ? H(T, z, K) : (z + K) / 2,
                      U = W + (T - W) * (1 - g),
                      Y = B;
                    if (tZ.x > 0.01) {
                      let e = 20 * H(tZ.x, 0, 1.4),
                        r = U - j[0],
                        i = Y - j[1],
                        a = Math.hypot(r, i) || 1,
                        n = r / a,
                        s = i / a,
                        l =
                          e +
                          Math.hypot(
                            (0 === t ? X : q) * I * n,
                            x.EYE_HALF * N * s,
                          ) +
                          5;
                      a < l && ((U += n * (l - a)), (Y += s * (l - a)));
                    }
                    e.setAttribute(
                      "transform",
                      `translate(${U.toFixed(2)} ${Y.toFixed(2)}) scale(${I.toFixed(4)} ${N.toFixed(4)}) translate(${(-r).toFixed(2)} ${(-i).toFixed(2)})`,
                    );
                  }
        /* ---- rings & effects ------------------------------------------------
         * compute the current outline path (morphing between ring shapes if
         * the shape prop changed), push it into the head + clipPath, then
         * dispatch the active effect renderer. */
                  let tC = H(tw.x, 0, 1),
                    tv = H(tF.x, 0, 1),
                    tH = tv < 0.999 ? tk : null,
                    t$ = H(tC / 0.62, 0, 1),
                    tP = "pencil" === t_ || "pencil" === tH,
                    tS = tP
                      ? tv >= 0.999
                        ? K(t_)
                        : (0, x.lerpRing)(K(tH), K(t_), $(tv))
                      : p.CIRCLE_RING;
                  if (
                    O ||
                    ep ||
                    t$ !== eM ||
                    C !== ex ||
                    ti.current !== eb ||
                    tP
                  ) {
                    let t =
                      t$ >= 1
                        ? tP
                          ? (0, p.ringOutline)(tS)
                          : z
                        : !(t$ <= 0) || v || O
                          ? (0, p.ringOutline)(
                              t$ <= 0 ? D : (0, x.lerpRing)(D, tS, $(t$)),
                            )
                          : k.path;
                    (ta.current?.setAttribute("d", t),
                      tn.current?.setAttribute("d", t),
                      (eM = t$),
                      (ex = C),
                      (ep = O),
                      (eb = ti.current));
                  }
                  for (let t of th.current) t && (t.style.display = "none");
                  for (let t of td.current) t && (t.style.display = "none");
                  for (let t of tl.current) t && (t.style.display = "none");
                  for (let t of tu.current) t && (t.style.display = "none");
                  let tR = (t) =>
                      null == t
                        ? 0
                        : t === t_
                          ? tC * tv
                          : t === tH
                            ? tC * (1 - tv)
                            : 0,
                    tI = {
                      dots: 22,
                      orbit: 19,
                      radar: 19,
                      progress: 19,
                      gather: 19,
                      wave: 16,
                      send: 20,
                      receive: 20,
                      dock: 20,
                      ball: 18,
                      whirl: 15,
                      pencil: 17,
                      bang: 13,
                      standby: 13,
                    },
                    tj = t_
                      ? tI[t_] * tv + (tH ? tI[tH] : tI[t_]) * (1 - tv)
                      : 19,
                    tN = eR(a, 1, tC),
                    tO = "dots" === t_ || "dots" === tH,
                    tB = tR("dots"),
                    tL = tO ? 1 + (tN.pop - 1) * (tB / Math.max(tC, 0.001)) : 1,
                    tz = a - tM.current,
                    tV = tR("receive");
                  tV > 0.004 &&
                    (tL *=
                      1 +
                      0.11 *
                        Math.sin(
                          H(
                            (((((tz / 1700) % 1) + 1) % 1) - 0.58) / 0.34,
                            0,
                            1,
                          ) * Math.PI,
                        ) *
                        tV);
                  let tK = tR("send");
                  if (tK > 0.004) {
                    let t = (((tz / 1500) % 1) + 1) % 1;
                    tL *=
                      1 +
                      ((t < 0.18 ? -0.06 * Math.sin((t / 0.18) * Math.PI) : 0) +
                        (t >= 0.18 && t < 0.42
                          ? 0.05 * Math.sin(((t - 0.18) / 0.24) * Math.PI)
                          : 0)) *
                        tK;
                  }
                  let tT = tR("bang");
                  tT > 0.004 &&
                    (tL *=
                      1 + 0.04 * Math.exp(-(((tz / 1e3) % 2.2) * 5.5)) * tT);
                  let tG = 0,
                    tX = 0,
                    tW = 0,
                    tU = tR("pencil");
                  if (tU > 0.004) {
                    let t = eT(a);
                    ((tG += t.x * tU),
                      (tX += (t.y + 0.5 * t.wig) * tU),
                      (tW += t.rot * tU));
                  }
                  tT > 0.004 && (tX += 58 * tT);
                  let tJ = tR("whirl");
                  if (tJ > 0.004) {
                    let t = a / 1e3;
                    ((tG +=
                      (2 * Math.sin(0.9 * t) + 0.8 * Math.sin(1.7 * t)) * tJ),
                      (tX +=
                        (2.4 * Math.sin(1.3 * t) + 1.2 * Math.sin(0.6 * t)) *
                        tJ));
                  }
                  let tQ = tR("ball");
                  if (tQ > 0.004) {
                    let t,
                      e = (a - tM.current) / 1e3,
                      r = 416 / 0.3844,
                      i = Math.sqrt(80 / (416 / 0.3844));
                    if (e < i) t = 40 - 0.5 * r * e * e;
                    else {
                      let r = ((((e - i) / 0.62) % 1) + 1) % 1;
                      t = 208 * r * (1 - r);
                    }
                    tX += (40 - t) * tQ;
                  }
                  let t1 = (tj / x.HEAD_C) * tL;
                  if (N.current) {
                    let t = 1 - tC,
                      e = s.x * t + em * t + tG * tC,
                      r = (l.x + ef) * t + eE * t - tN.lift * tB + tX * tC,
                      i = (n.x * t + eA * t) * I + ew * t + tW * tC,
                      u = t + t1 * tC,
                      h = o.x * t + t1 * tC;
                    N.current.setAttribute(
                      "transform",
                      `translate(${(x.HEAD_C + e).toFixed(2)} ${(x.HEAD_C + r).toFixed(2)}) rotate(${i.toFixed(2)}) scale(${u.toFixed(4)} ${h.toFixed(4)}) translate(${-x.HEAD_C} ${-x.HEAD_C})`,
                    );
                    let d = tR("standby"),
                      c = d > 0 ? (0.28 + 0.2 * Math.sin(0.0016 * a)) * d : 0;
                    N.current.style.opacity = (
                      (1 - (1 - tN.tone) * tB) *
                      (1 - c)
                    ).toFixed(3);
                  }
                  if (((tZ.t = +("notifying" === tc.current)), to.current)) {
                    let t = H(tZ.x, 0, 1.4);
                    t <= 0.01
                      ? (to.current.style.display = "none")
                      : ((to.current.style.display = ""),
                        (to.current.style.fill = tt.current),
                        to.current.setAttribute("cx", j[0].toFixed(1)),
                        to.current.setAttribute("cy", j[1].toFixed(1)),
                        to.current.setAttribute(
                          "r",
                          (20 * te.current * t).toFixed(2),
                        ));
                  }
                  for (let t of B) {
                    let e = tR(t);
                    e <= 0.004 ||
                      ("dots" === t
                        ? eI(e, a)
                        : "orbit" === t
                          ? ej(e, a)
                          : "radar" === t
                            ? eN(e, a, tj)
                            : "progress" === t
                              ? eO(e, a)
                              : "gather" === t
                                ? eB(e, a)
                                : "wave" === t
                                  ? eL(e, a)
                                  : "send" === t
                                    ? ez(e, a)
                                    : "receive" === t
                                      ? eV(e, a)
                                      : "dock" === t
                                        ? eK(e, a)
                                        : "pencil" === t
                                          ? eG(e, a)
                                          : "bang" === t
                                            ? eX(e, a)
                                            : "standby" === t && eW(e, a));
                  }
        /* breathing zoom: gently scale the viewBox so the head "breathes" */
                  if (R.current) {
                    let t = 1 - S(H((ea - 44) / 90, 0, 1)),
                      e = t_ ? T[t_] : 1,
                      r = tH ? T[tH] : e,
                      i = 129.5 / (1 + (e * tv + r * (1 - tv) - 1) * tC * t),
                      a = `${(114.5 - i).toFixed(2)} ${(114.5 - i).toFixed(2)} ${(2 * i).toFixed(2)} ${(2 * i).toFixed(2)}`;
                    a !== en &&
                      (R.current.setAttribute("viewBox", a), (en = a));
                  }
                  let t0 = H(tY.x, 0, 1);
                  if (t0 > 0.01)
                    for (let t = 0; t < 2; t++) {
                      let e = th.current[3 + t];
                      if (!e) continue;
                      let r = 0.85 * tq + t * Math.PI,
                        i = 1.3 * k.radius,
                        a = 0.55 + 0.45 * H((Math.cos(r) + 1) / 2, 0, 1);
                      ((e.style.display = ""),
                        e.setAttribute(
                          "cx",
                          (x.HEAD_C + i * Math.sin(r)).toFixed(1),
                        ),
                        e.setAttribute(
                          "cy",
                          (x.HEAD_C - 0.38 * i * Math.cos(r) - 8).toFixed(1),
                        ),
                        e.setAttribute("r", (7.5 * a * t0).toFixed(2)),
                        e.setAttribute(
                          "opacity",
                          ((0.3 + 0.7 * a) * t0).toFixed(3),
                        ));
                    }
                })(M),
                ((t) => {
                  if (t - es < 500 || !R.current) return;
                  es = t;
                  let e = R.current.getBoundingClientRect().width;
                  e > 0 && ((ei = H((340 / e) ** 0.7, 1, 2.6)), (ea = e));
                })(M));
              let O = "humming" === tc.current,
                V = "loading" === tc.current;
              if (((tY.t = +!!O), (O || V) && !t)) {
                let t = (M - tM.current) / 1e3,
                  e = V ? 3 : 1.6,
                  r =
                    t < 0.5
                      ? 7 * $(t / 0.5)
                      : t < 1.3
                        ? 7 + (e - 7) * $((t - 0.5) / 0.8)
                        : e + 0.3 * Math.sin(0.5 * t);
                tq += r * F;
              }
              (t7
                ? (ec = t7.x)
                : null !== ev
                  ? (ec = ev)
                  : (O || V) && (ec = tq),
                ed.update(M, F, {
                  spinAngle: ec,
                  sizeScale: ei,
                  wideStyle: eC?.kind === "spinWild" || eD || O,
                }),
                (t5 = requestAnimationFrame(eU)));
            };
          return (
      /* expose the imperative API (spin / bounce / burst) through the handle */
            (tr.current = {
              spin: (t = 1) => eo(t),
              bounce: () => ek(),
              burst: () => ed.burst(22, 1.1, 0.3),
            }),
            (t5 = requestAnimationFrame(eU)),
            () => cancelAnimationFrame(t5)
          );
        }, [F]));
    /* ===== render ============================================================ */
      let tx = p.SHAPES[e];
    /* The SVG structure:
     *   <svg class="grok-bot-mark" data-state=...>
     *     <defs><clipPath>       — head outline, so eye shapes never spill out
     *     hidden layers          — dot paths, ring circles, part circles,
     *                              glyph paths (effects) + particle layers
     *     <g ref=N> (the body)   — head path + clipped group with the two
     *                              eye paths + notification dot
     *
     * Colours are NOT hardcoded here. The icon's CSS uses
     * .grok-bot-mark__head { fill: var(--fg) } and
     * .grok-bot-mark__eye  { fill: var(--bg) } — the page that mounts the bot
     * provides --fg/--bg (on x.ai: hsl(var(--primary)) / hsl(var(--background))). */
      return (0, d.jsxs)("svg", {
        ref: R,
        className: i ? `grok-bot-mark ${i}` : "grok-bot-mark",
        style: {
          overflow: "visible",
          ...(r ? { width: r, height: r } : {}),
          ...(s ? { transform: "scaleX(-1)" } : {}),
        },
        "data-state": t,
        viewBox: "-15 -15 259 259",
        xmlns: "http://www.w3.org/2000/svg",
        children: [
          (0, d.jsx)("defs", {
            children: (0, d.jsx)("clipPath", {
              id: F,
              children: (0, d.jsx)("path", { ref: tn, d: tx.path }),
            }),
          }),
          (0, d.jsx)("g", { ref: O, "aria-hidden": "true" }),
          [0, 1].map((t) =>
            (0, d.jsx)(
              "path",
              {
                className: "grok-bot-mark__head",
                d: z,
                style: { display: "none" },
                ref: (e) => {
                  tl.current[t] = e;
                },
              },
              t,
            ),
          ),
          [0, 1, 2, 3, 4].map((t) =>
            (0, d.jsx)(
              "circle",
              {
                cx: x.HEAD_C,
                cy: x.HEAD_C,
                r: 0,
                fill: "none",
                style: { display: "none", stroke: "var(--fg)" },
                ref: (e) => {
                  td.current[t] = e;
                },
              },
              `ring${t}`,
            ),
          ),
          [0, 1, 2, 3, 4].map((t) =>
            (0, d.jsx)(
              "circle",
              {
                className: "grok-bot-mark__head",
                cx: x.HEAD_C,
                cy: x.HEAD_C,
                r: 0,
                style: { display: "none" },
                ref: (e) => {
                  th.current[t] = e;
                },
              },
              `part${t}`,
            ),
          ),
          [0, 1, 2].map((t) =>
            (0, d.jsx)(
              "path",
              {
                style: { display: "none" },
                ref: (e) => {
                  tu.current[t] = e;
                },
              },
              `glyph${t}`,
            ),
          ),
          (0, d.jsxs)("g", {
            ref: N,
            children: [
              (0, d.jsx)("path", {
                ref: ta,
                className: "grok-bot-mark__head",
                d: tx.path,
              }),
              (0, d.jsxs)("g", {
                clipPath: `url(#${F})`,
                children: [
                  (0, d.jsx)("path", {
                    className: "grok-bot-mark__eye",
                    ref: (t) => {
                      ts.current[0] = t;
                    },
                  }),
                  (0, d.jsx)("path", {
                    className: "grok-bot-mark__eye",
                    ref: (t) => {
                      ts.current[1] = t;
                    },
                  }),
                ],
              }),
              (0, d.jsx)("circle", {
                ref: to,
                cx: x.HEAD_C,
                cy: x.HEAD_C,
                r: 0,
                style: {
                  display: "none",
                  stroke: "var(--bg)",
                  strokeWidth: 10,
                },
              }),
            ],
          }),
          (0, d.jsx)("g", { ref: V, "aria-hidden": "true" }),
        ],
      });
    });
  /* register the component as the module's "GrokBot" export */
  t.s(["GrokBot", 0, Y], 111605);
};
