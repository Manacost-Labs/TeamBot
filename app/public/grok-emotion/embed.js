(function (global) {
  "use strict";

  var script = document.currentScript;
  var scriptUrl = new URL(script && script.src ? script.src : "./embed.js", window.location.href);
  var baseUrl = script && script.dataset.base ? script.dataset.base.replace(/\/$/, "") : scriptUrl.origin;
  var embedOrigin = new URL(baseUrl, window.location.href).origin;

  var states = [
    "sleeping", "waking", "idle", "listening", "thinking", "searching", "working",
    "excited", "surprised", "suspicious", "angry", "drowsy", "happy", "curious",
    "confused", "bored", "proud", "shy", "sad", "laughing", "scared", "playful",
    "celebrate", "orbit", "radar", "progress", "spawning", "humming", "loading",
    "dictating", "writing", "sending", "receiving", "uploading", "notifying",
    "alerting", "dragging", "bouncing", "powering-down"
  ];
  var shapes = [
    "blob", "pebble", "bean", "egg", "squircle", "tablet", "capsule", "cylinder",
    "hex", "gem", "crystal", "wedge", "shield", "dome", "arch", "cloud",
    "teardrop", "leaf"
  ];
  var colors = [
    { name: "Белый", value: "#f4f4f4", eyes: "#0a0a0a" },
    { name: "Коричневый", value: "#946b43", eyes: "#0a0a0a" },
    { name: "Красный", value: "#dc2942", eyes: "#0a0a0a" },
    { name: "Оранжевый", value: "#ee6200", eyes: "#0a0a0a" },
    { name: "Янтарный", value: "#f39a08", eyes: "#0a0a0a" },
    { name: "Зелёный", value: "#08a96f", eyes: "#08110d" },
    { name: "Бирюзовый", value: "#11a99f", eyes: "#07100f" },
    { name: "Синий", value: "#2f80ed", eyes: "#07101c" },
    { name: "Фиолетовый", value: "#7042d6", eyes: "#ffffff" },
    { name: "Розовый", value: "#dc3188", eyes: "#16040d" },
    { name: "Серый", value: "#b7b7b7", eyes: "#0a0a0a" }
  ];

  function resolveTarget(target) {
    var element = typeof target === "string" ? document.querySelector(target) : target;
    if (!element || element.nodeType !== 1) throw new Error("GrokEmotion.mount: target element was not found");
    return element;
  }

  function sanitize(config) {
    config = config || {};
    return {
      state: states.indexOf(config.state) !== -1 ? config.state : "idle",
      shape: shapes.indexOf(config.shape) !== -1 ? config.shape : "blob",
      color: /^#[0-9a-f]{6}$/i.test(config.color || "") ? config.color : "#08a96f",
      eyes: /^#[0-9a-f]{6}$/i.test(config.eyes || "") ? config.eyes : "#08110d",
      size: Math.max(16, Math.min(800, Number(config.size) || 280)),
      autoCycle: config.autoCycle === true
    };
  }

  function mount(target, initialConfig) {
    var container = resolveTarget(target);
    var config = sanitize(initialConfig);
    var params = new URLSearchParams({
      embed: "1",
      state: config.state,
      shape: config.shape,
      color: config.color,
      eyes: config.eyes,
      size: String(config.size),
      auto: config.autoCycle ? "1" : "0"
    });
    var iframe = document.createElement("iframe");
    iframe.src = baseUrl + "/index.html?" + params.toString();
    iframe.title = "Animated AI agent avatar";
    iframe.loading = "eager";
    iframe.style.display = "block";
    iframe.style.width = "100%";
    iframe.style.height = "100%";
    iframe.style.border = "0";
    iframe.style.background = "transparent";
    iframe.setAttribute("allowtransparency", "true");
    container.replaceChildren(iframe);

    var ready = false;
    var listeners = new Set();
    function send() {
      if (!ready || !iframe.contentWindow) return;
      iframe.contentWindow.postMessage({ type: "grok-emotion:update", config: config }, embedOrigin);
    }
    function onMessage(event) {
      if (event.origin !== embedOrigin || event.source !== iframe.contentWindow) return;
      if (event.data && event.data.type === "grok-emotion:ready") {
        ready = true;
        send();
      }
    }
    window.addEventListener("message", onMessage);
    iframe.addEventListener("load", function () { ready = true; send(); });

    function notify() {
      var snapshot = Object.assign({}, config);
      listeners.forEach(function (listener) { listener(snapshot); });
      container.dispatchEvent(new CustomEvent("grok-emotion:change", { detail: snapshot }));
    }

    var controller = {
      iframe: iframe,
      getConfig: function () { return Object.assign({}, config); },
      update: function (next) {
        config = sanitize(Object.assign({}, config, next || {}));
        send();
        notify();
        return controller;
      },
      setState: function (state) { return controller.update({ state: state, autoCycle: false }); },
      setShape: function (shape) { return controller.update({ shape: shape }); },
      setColor: function (color, eyes) { return controller.update({ color: color, eyes: eyes || config.eyes }); },
      replay: function () { send(); return controller; },
      onChange: function (listener) {
        if (typeof listener !== "function") throw new TypeError("GrokEmotion.onChange: listener must be a function");
        listeners.add(listener);
        listener(Object.assign({}, config));
        return function () { listeners.delete(listener); };
      },
      destroy: function () {
        window.removeEventListener("message", onMessage);
        listeners.clear();
        iframe.remove();
      }
    };
    return controller;
  }

  global.GrokEmotion = {
    version: "1.1.0",
    baseUrl: baseUrl,
    manifestUrl: baseUrl + "/manifest.json",
    states: states.slice(),
    shapes: shapes.slice(),
    colors: colors.map(function (color) { return Object.assign({}, color); }),
    mount: mount
  };
})(window);
