"use strict";

const data = window.WMJ_DATA;
const byId = (id) => document.getElementById(id);
const svg = byId("chart");
const slider = byId("position");
const play = byId("play");
const scenario = byId("scenario");
const solver = byId("solver");
const budgetSelect = byId("budget");
const palette = ["#9be5d1", "#f2bf85", "#88a9cf"];
const modes = {
  step: {
    title: "不等腿长 · 速度指令响应",
    label: "联合功率 FGM",
    choices: { FGM_joint: "FGM · 联合功率" },
  },
  comparison: {
    title: "不等腿长 · 求解器对照",
    label: "求解器",
    choices: {
      FGM_joint: "FGM · 联合功率",
      FGM_box: "FGM · 预算盒",
      OSQP_box: "OSQP · 预算盒",
      OSQP_PWL8: "OSQP · 8 段逐轮功率",
    },
  },
};
const configs = {
  speed: { title: "速度", unit: "m/s", keys: ["speed", "target"], labels: ["前进速度", "参考速度"] },
  pitch: { title: "俯仰", unit: "°", keys: ["pitch", "zero"], labels: ["俯仰角", "零位"] },
  torque: { title: "轮矩", unit: "N·m", keys: ["left", "right"], labels: ["左轮", "右轮"] },
  power: { title: "功率", unit: "W", keys: ["power", "limit"], labels: ["双轮功率", "预算"] },
  delta: { title: "跟踪误差", unit: "m/s", keys: ["error", "zero"], labels: ["实际速度 − 参考速度", "零误差"] },
};
let signal = "speed";
let index = Number(slider.value);
let animation = null;
let graph;
let active;
let cursor;
let reveal;
let markers;

function node(tag, attributes = {}, value) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, attr] of Object.entries(attributes)) element.setAttribute(name, attr);
  if (value !== undefined) element.textContent = value;
  return element;
}

function niceStep(span) {
  const raw = span / 5;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 2.5, 5, 10].find((candidate) => candidate * magnitude >= raw) || 10) * magnitude;
}

function setChart() {
  const tunedDemo = scenario.value === "step";
  const traces = data.traces;
  const budget = Number(budgetSelect.value);
  const runs = traces[budget];
  active = runs[solver.value];
  const series = active.series;
  const cfg = configs[signal];
  const count = series.speed.length;
  const joint = runs.FGM_joint.series;
  const delta = series.speed.map((value, k) => 1000 * (value - joint.speed[k]));
  const error = series.speed.map((value, k) => value - series.target[k]);
  const values = cfg.keys.map((key) =>
    key === "limit" ? Array(count).fill(budget) :
    key === "zero" ? Array(count).fill(0) : key === "error" ? error : series[key]);
  const labels = [...cfg.labels];
  if (!tunedDemo && signal === "speed" && solver.value !== "FGM_joint") {
    values.push(joint.speed);
    labels.push("联合功率 FGM 参考");
  }
  slider.max = count - 1;
  byId("selection").textContent = `${budget} W · ${modes[scenario.value].choices[solver.value]} · ${cfg.title}`;
  byId("chart-legend").replaceChildren(...labels.map((label, k) => {
    const item = document.createElement("span");
    const swatch = document.createElement("i");
    swatch.style.setProperty("--series-color", palette[k]);
    item.append(swatch, label);
    return item;
  }));
  const peakPower = Math.max(...series.power).toFixed(2);
  const duration = (series.speed.length * data.dt).toFixed(1);
  byId("scenario-caption").textContent = tunedDemo
    ? `${duration} s 非线性仿真 · ${data.initialSpeed.toFixed(1)} → ${active.request.toFixed(1)} m/s · 外部 LESO · Q/R 整定`
    : `${duration} s 非线性仿真 · ${active.request.toFixed(1)} m/s 请求速度 · 相同 Q/R、噪声、外部 LESO 与扰动`;
  const { t90, overshoot } = active.response;
  byId("scope-note").textContent = `90% 增量 ${t90.toFixed(3)} s · 超调 ${overshoot.toFixed(1)}% · 末秒最大俯仰 ${active.tailPitch.toFixed(3)}° · 峰值功率 ${peakPower} W · 求解有效 ${active.valid}/${active.count}`;
  byId("difference-panel").hidden = tunedDemo;
  if (!tunedDemo) drawDifference(delta, runs, budget);
  updateTiming(budget);
  let low = Math.min(0, ...values.flat());
  let high = Math.max(0, ...values.flat());
  if (signal === "power") high = Math.max(65, high);
  if (signal === "delta") {
    const extent = Math.max(.05, Math.abs(low), Math.abs(high));
    low = -extent;
    high = extent;
  }
  if (low === high) high += 1;
  const step = niceStep(high - low);
  low = Math.floor(low / step) * step;
  high = Math.ceil(high / step) * step;
  if (Math.max(...values[0]) >= high - step * .06) high += step * .15;

  const width = Math.max(270, Math.round(svg.getBoundingClientRect().width || 760));
  const height = width < 500 ? 245 : 300;
  const left = 53, right = width - 15, top = 29, bottom = height - 30;
  const x = (k) => left + (right - left) * k / (count - 1);
  const y = (v) => bottom - (v - low) * (bottom - top) / (high - low);
  graph = { x, y, values, top, bottom, left };
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.replaceChildren(node("title", { id: "chart-title" }, `${budget} W · ${cfg.title}仿真响应曲线`));

  const defs = node("defs");
  const clipping = node("clipPath", { id: "trace-clip" });
  reveal = node("rect", { x: left, y: top - 2, width: right - left, height: bottom - top + 4 });
  clipping.append(reveal);
  defs.append(clipping);
  svg.append(defs);
  svg.append(node("text", { x: left, y: 16, "font-size": 11 }, cfg.unit));
  for (let tick = low; tick <= high + 1e-8; tick += step) {
    const pos = y(tick);
    svg.append(node("line", { x1: left, x2: right, y1: pos, y2: pos, stroke: "#294253", "stroke-width": 1 }));
    svg.append(node("text", { x: left - 8, y: pos + 4, "font-size": 11, "text-anchor": "end" }, Number(tick.toPrecision(4))));
  }
  const divisions = width < 470 ? 3 : 6;
  for (let k = 0; k <= divisions; k++) {
    const pos = x(k * (count - 1) / divisions);
    const seconds = Number((k * (count - 1) * data.dt / divisions).toFixed(2));
    svg.append(node("line", { x1: pos, x2: pos, y1: top, y2: bottom, stroke: "#253d50", "stroke-width": 1 }));
    svg.append(node("text", { x: pos, y: height - 10, "font-size": 11, "text-anchor": k === divisions ? "end" : "middle" }, `${seconds}s`));
  }

  const shapes = values.map((line, k) => node("path", {
    d: line.map((value, sample) => `${sample ? "L" : "M"}${x(sample).toFixed(2)},${y(value).toFixed(2)}`).join(" "),
    fill: "none", stroke: palette[k], "stroke-width": k ? 1.5 : 2,
    "stroke-dasharray": k === 1 && signal !== "torque" ? "5 4" : "",
    "stroke-linejoin": "round", "stroke-linecap": "round",
  }));
  const future = node("g", { opacity: ".18" });
  future.append(...shapes.map((path) => path.cloneNode(true)));
  const past = node("g", { "clip-path": "url(#trace-clip)" });
  past.append(...shapes);
  cursor = node("line", { y1: top, y2: bottom, stroke: "#bbd1db", "stroke-width": 1, "stroke-dasharray": "3 4" });
  markers = values.map((_, k) => node("circle", { r: 3.7, fill: palette[k], stroke: "#102131", "stroke-width": 1.1 }));
  svg.append(future, past, cursor, ...markers);
  setPosition(index);
}

function drawDifference(delta, runs, budget) {
  const box = byId("diff-chart");
  const width = Math.max(270, Math.round(svg.getBoundingClientRect().width || 760));
  const height = 175, left = 65, right = width - 15, top = 25, bottom = 145;
  const peak = Math.max(...delta.map(Math.abs));
  const extent = Math.max(.001, peak * 1.15);
  const x = (i) => left + (right-left) * i / (delta.length-1);
  const y = (v) => (top+bottom)/2 - v*(bottom-top)/(2*extent);
  box.setAttribute("viewBox", `0 0 ${width} ${height}`);
  box.replaceChildren(node("title", {}, "所选方案与同预算联合功率 FGM 的速度差"));
  for (const v of [-extent, 0, extent]) {
    box.append(node("line", { x1:left,x2:right,y1:y(v),y2:y(v),stroke:"#294253" }));
    box.append(node("text", {x:left-8,y:y(v)+4,"text-anchor":"end","font-size":10}, v.toPrecision(3)));
  }
  box.append(node("text", {x:left,y:15,"font-size":11}, "mm/s"));
  box.append(node("path", {d:delta.map((v,i)=>`${i?"L":"M"}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(" "),fill:"none",stroke:palette[0],"stroke-width":1.6}));
  for(const i of [0, .5, 1]) box.append(node("text", {x:x(i*(delta.length-1)),y:170,"font-size":11,"text-anchor":i===1?"end":"start"}, `${(i*(delta.length-1)*data.dt).toFixed(1)}s`));
  byId("difference-title").textContent = `${modes.comparison.choices[solver.value]} − 联合功率 FGM · ${budget} W`;
  byId("difference-note").textContent = `全程速度差峰值 ${peak.toFixed(6)} mm/s。` +
    (solver.value === "FGM_joint" ? "当前选择即参考方案。" : peak < .01 ? "当前工况下控制输出高度一致，主图重合。" : "上图查看响应，下图放大方案间的差异。") + " 差值图显示完整记录。";
}

function updateTiming(budget) {
  byId("timing-budget").textContent = `${budget} W · 相同 10 s 场景 · 每方案 4,980 拍计时`;
  const rows = byId("solver-rows").rows;
  Object.values(data.traces[budget]).forEach((run, k) => {
    rows[k].cells[1].textContent = `${run.timing.median.toFixed(3)}`;
    rows[k].cells[2].textContent = `${run.timing.p95.toFixed(3)}`;
    rows[k].cells[3].textContent = `${run.valid}/${run.count}`;
  });
}

function setPosition(sample) {
  index = Math.min(Number(slider.max), Math.max(0, Math.round(sample)));
  slider.value = index;
  const time = (index * data.dt).toFixed(2);
  byId("clock").textContent = `${time} s`;
  slider.setAttribute("aria-valuetext", `${time} 秒`);
  byId("read-speed").textContent = active.series.speed[index].toFixed(2);
  byId("read-pitch").textContent = active.series.pitch[index].toFixed(2);
  byId("read-power").textContent = active.series.power[index].toFixed(2);
  byId("read-active").textContent = active.active;
  const pos = graph.x(index);
  cursor.setAttribute("x1", pos);
  cursor.setAttribute("x2", pos);
  reveal.setAttribute("width", pos - graph.left + 1);
  markers.forEach((marker, k) => {
    marker.setAttribute("cx", pos);
    marker.setAttribute("cy", graph.y(graph.values[k][index]));
  });
}

function pause() {
  if (animation !== null) cancelAnimationFrame(animation);
  animation = null;
  play.textContent = "▶ 播放";
}

play.addEventListener("click", () => {
  if (animation !== null) {
    pause();
    return;
  }
  if (index >= Number(slider.max)) setPosition(0);
  const origin = performance.now() - index * data.dt * 1000;
  play.textContent = "Ⅱ 暂停";
  const tick = (now) => {
    setPosition((now - origin) / (data.dt * 1000));
    if (index < Number(slider.max)) animation = requestAnimationFrame(tick);
    else pause();
  };
  animation = requestAnimationFrame(tick);
});
slider.addEventListener("input", () => {
  pause();
  setPosition(Number(slider.value));
});
const signalButtons = [...document.querySelectorAll("[data-signal]")];
function selectSignal(next) {
  signal = next;
  signalButtons.forEach((tab) => tab.setAttribute("aria-pressed", String(tab.dataset.signal === next)));
}

function redrawSelection() {
  pause();
  index = Number.MAX_SAFE_INTEGER;
  setChart();
}

scenario.addEventListener("change", () => {
  const mode = modes[scenario.value];
  byId("scope-title").textContent = mode.title;
  byId("solver-label").textContent = mode.label;
  solver.replaceChildren(...Object.entries(mode.choices).map(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    return option;
  }));
  solver.value = scenario.value === "comparison" ? "OSQP_PWL8" : "FGM_joint";
  selectSignal("speed");
  redrawSelection();
});
for (const control of [budgetSelect, solver]) control.addEventListener("change", redrawSelection);
for (const button of signalButtons) {
  button.addEventListener("click", () => {
    selectSignal(button.dataset.signal);
    setChart();
  });
}

const cached = data.bench.MPC_cached;
const changing = data.bench.MPC_changing_lengths;
byId("hero-max").textContent = changing.max.toFixed(3);
byId("board-max").textContent = changing.max.toFixed(3);
byId("hero-ticks").textContent = (cached.samples + changing.samples).toLocaleString("zh-CN");
for (const [id, record] of [["cached", cached], ["changing", changing]]) {
  byId(`${id}-ms`).textContent = `${record.max.toFixed(3)} ms`;
  byId(`${id}-bar`).style.width = `${record.max * 50}%`;
}
byId("margin-ms").textContent = `${(2 - changing.max).toFixed(3)} ms`;

setChart();
if ("ResizeObserver" in window) {
  let width = svg.getBoundingClientRect().width;
  new ResizeObserver(() => {
    const next = svg.getBoundingClientRect().width;
    if (next !== width) {
      width = next;
      setChart();
    }
  }).observe(svg);
}
