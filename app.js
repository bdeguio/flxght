// Animated flight map
// airports.txt format: CODE,LATITUDE,LONGITUDE
// sequence.txt format: comma-, space-, or newline-separated airport codes

const CONFIG = Object.freeze({
  width: 975,
  height: 610,
  speedPxPerMs: 0.06,
  minLegMs: 3000,
  maxLegMs: 9000,
  arrivalHoldMs: 450,
  trailLifetimeMs: 2400,
  trailSampleMs: 28,
  trailBins: 30,
  markerRadius: 4.5,
  maxCompletedPaths: 1400
});

const MAP_URL =
  "https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json";

const svg = d3
  .select("#map")
  .attr("viewBox", `0 0 ${CONFIG.width} ${CONFIG.height}`)
  .attr("preserveAspectRatio", "xMidYMid meet");

const projection = d3.geoAlbersUsa();
const geoPath = d3.geoPath(projection);

const gMap = svg.append("g").attr("class", "map-layer");
const gLegs = svg.append("g").attr("class", "legs-layer");
const gAirports = svg.append("g").attr("class", "airports-layer");
const gTrail = svg.append("g").attr("class", "trail-layer");

const marker = svg
  .append("circle")
  .attr("class", "marker")
  .attr("r", CONFIG.markerRadius)
  .style("display", "none");

const legLabel = document.getElementById("leg-label");
const progressLabel = document.getElementById("progress-label");
const playBtn = document.getElementById("play-btn");
const pauseBtn = document.getElementById("pause-btn");
const restartBtn = document.getElementById("restart-btn");

let airports = {};
let sequence = [];
let legs = [];

let initialLegIndex = 0;
let currentLegIndex = -1;
let currentPathData = null;

let motionPath = null;
let motionPathLength = 0;
let currentLegDuration = CONFIG.minLegMs;

let playing = false;
let phase = "idle"; // idle | flying | holding
let phaseStartedAt = 0;
let elapsedBeforePause = 0;
let rafId = null;

let markerPosition = null;
let trailSamples = [];
let lastTrailSampleAt = -Infinity;

function fetchText(url) {
  return fetch(url).then((response) => {
    if (!response.ok) {
      throw new Error(`${url} returned HTTP ${response.status}`);
    }

    return response.text();
  });
}

function fetchJson(url) {
  return fetch(url).then((response) => {
    if (!response.ok) {
      throw new Error(`${url} returned HTTP ${response.status}`);
    }

    return response.json();
  });
}

function parseAirports(text) {
  const parsed = {};

  for (const line of text.split(/\r?\n/)) {
    const [rawCode, rawLat, rawLon] = line.split(",");

    const code = rawCode?.trim();
    const lat = Number.parseFloat(rawLat);
    const lon = Number.parseFloat(rawLon);

    if (
      !code ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon)
    ) {
      continue;
    }

    parsed[code] = [lat, lon];
  }

  return parsed;
}

function parseSequence(text) {
  return text
    .split(/[\s,]+/)
    .map((code) => code.trim())
    .filter(Boolean);
}

function buildLegs(codes) {
  const validLegs = [];
  const skippedCodes = new Set();

  for (let i = 0; i < codes.length - 1; i += 1) {
    const from = codes[i];
    const to = codes[i + 1];

    if (!airports[from] || !airports[to]) {
      if (!airports[from]) {
        skippedCodes.add(from);
      }

      if (!airports[to]) {
        skippedCodes.add(to);
      }

      continue;
    }

    if (from === to) {
      continue;
    }

    validLegs.push({ from, to });
  }

  if (skippedCodes.size > 0) {
    console.warn(
      "Airport codes skipped because coordinates are missing:",
      [...skippedCodes].join(", ")
    );
  }

  return validLegs;
}

function projectAirport(code) {
  const coordinates = airports[code];

  if (!coordinates) {
    return null;
  }

  const [lat, lon] = coordinates;

  return projection([lon, lat]);
}

function drawAirports() {
  const points = Object.keys(airports)
    .map((code) => {
      const point = projectAirport(code);

      if (!point) {
        return null;
      }

      return {
        code,
        x: point[0],
        y: point[1]
      };
    })
    .filter(Boolean);

  gAirports
    .selectAll("circle")
    .data(points, (d) => d.code)
    .join("circle")
    .attr("class", "airport-dot")
    .attr("cx", (d) => d.x)
    .attr("cy", (d) => d.y)
    .attr("r", 1.6);
}

function createLegPathData(from, to) {
  const p1 = projectAirport(from);
  const p2 = projectAirport(to);

  if (!p1 || !p2) {
    return null;
  }

  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  const distance = Math.hypot(dx, dy);

  if (distance < 0.001) {
    return null;
  }

  const bend = Math.min(
    42,
    Math.max(12, distance * 0.09)
  );

  const normalX = -dy / distance;
  const normalY = dx / distance;

  const controlX =
    (p1[0] + p2[0]) / 2 +
    normalX * bend;

  const controlY =
    (p1[1] + p2[1]) / 2 +
    normalY * bend;

  return (
    `M${p1[0]},${p1[1]} ` +
    `Q${controlX},${controlY} ` +
    `${p2[0]},${p2[1]}`
  );
}

function updateLegLabel(leg, index) {
  legLabel.textContent = `${leg.from} → ${leg.to}`;
  progressLabel.textContent =
    `Leg ${index + 1} / ${legs.length}`;
}

function addTrailSample(point, now, force = false) {
  markerPosition = {
    x: point.x,
    y: point.y
  };

  if (
    !force &&
    now - lastTrailSampleAt < CONFIG.trailSampleMs
  ) {
    return;
  }

  const previous =
    trailSamples[trailSamples.length - 1];

  const moved =
    !previous ||
    Math.hypot(
      point.x - previous.x,
      point.y - previous.y
    ) > 0.35;

  if (moved) {
    trailSamples.push({
      x: point.x,
      y: point.y,
      time: now
    });
  } else if (previous) {
    previous.time = now;
  }

  lastTrailSampleAt = now;
}

function pruneTrail(now) {
  const cutoff =
    now - CONFIG.trailLifetimeMs;

  while (
    trailSamples.length > 0 &&
    trailSamples[0].time < cutoff
  ) {
    trailSamples.shift();
  }
}

function drawTrail(now) {
  pruneTrail(now);

  if (trailSamples.length < 2) {
    gTrail
      .selectAll(".trail-segment")
      .remove();

    return;
  }

  const bins = Array.from(
    { length: CONFIG.trailBins },
    () => []
  );

  for (
    let i = 1;
    i < trailSamples.length;
    i += 1
  ) {
    const start = trailSamples[i - 1];
    const end = trailSamples[i];

    const age = now - end.time;

    const ageRatio = Math.min(
      1,
      Math.max(
        0,
        age / CONFIG.trailLifetimeMs
      )
    );

    const binIndex = Math.min(
      CONFIG.trailBins - 1,
      Math.floor(
        ageRatio * CONFIG.trailBins
      )
    );

    bins[binIndex].push({
      start,
      end
    });
  }

  const visibleBins = bins
    .map((segments, index) => ({
      segments,
      index
    }))
    .filter(
      (entry) =>
        entry.segments.length > 0
    );

  gTrail
    .selectAll(".trail-segment")
    .data(
      visibleBins,
      (d) => d.index
    )
    .join(
      (enter) =>
        enter
          .append("path")
          .attr(
            "class",
            "trail-segment"
          ),
      (update) => update,
      (exit) => exit.remove()
    )
    .attr("d", (d) =>
      d.segments
        .map(
          ({ start, end }) =>
            `M${start.x},${start.y}` +
            `L${end.x},${end.y}`
        )
        .join("")
    )
    .attr(
      "stroke-width",
      (d) => {
        const freshness =
          1 -
          d.index /
            CONFIG.trailBins;

        return (
          0.55 +
          freshness * 3.75
        );
      }
    )
    .attr(
      "stroke-opacity",
      (d) => {
        const freshness =
          1 -
          d.index /
            CONFIG.trailBins;

        return (
          Math.pow(
            freshness,
            1.9
          ) * 0.9
        );
      }
    );
}

function clearTrail() {
  trailSamples = [];
  lastTrailSampleAt = -Infinity;

  gTrail
    .selectAll("*")
    .remove();
}

function trimCompletedPaths() {
  const paths = gLegs
    .selectAll(".leg-path-dim")
    .nodes();

  if (
    paths.length <=
    CONFIG.maxCompletedPaths
  ) {
    return;
  }

  const removeCount =
    paths.length -
    CONFIG.maxCompletedPaths;

  paths
    .slice(0, removeCount)
    .forEach((path) => {
      path.remove();
    });
}

function removeMotionPath() {
  if (!motionPath) {
    return;
  }

  motionPath.remove();
  motionPath = null;
}

function setupLeg(index, now) {
  if (legs.length === 0) {
    return false;
  }

  currentLegIndex =
    ((index % legs.length) +
      legs.length) %
    legs.length;

  const leg =
    legs[currentLegIndex];

  const pathData =
    createLegPathData(
      leg.from,
      leg.to
    );

  if (!pathData) {
    return setupLeg(
      currentLegIndex + 1,
      now
    );
  }

  /*
   * Store the current route but do not draw it yet.
   * The line appears only after arrival.
   */
  currentPathData = pathData;

  removeMotionPath();

  motionPath =
    document.createElementNS(
      "http://www.w3.org/2000/svg",
      "path"
    );

  motionPath.setAttribute(
    "d",
    pathData
  );

  motionPath.setAttribute(
    "visibility",
    "hidden"
  );

  svg.node().appendChild(
    motionPath
  );

  motionPathLength =
    motionPath.getTotalLength();

  currentLegDuration =
    Math.min(
      CONFIG.maxLegMs,
      Math.max(
        CONFIG.minLegMs,
        motionPathLength /
          CONFIG.speedPxPerMs
      )
    );

  phase = "flying";
  phaseStartedAt = now;
  elapsedBeforePause = 0;

  const startPoint =
    motionPath.getPointAtLength(0);

  marker
    .style("display", null)
    .attr("cx", startPoint.x)
    .attr("cy", startPoint.y);

  addTrailSample(
    startPoint,
    now,
    true
  );

  updateLegLabel(
    leg,
    currentLegIndex
  );

  return true;
}

function elapsedInCurrentPhase(now) {
  return (
    elapsedBeforePause +
    (playing
      ? now - phaseStartedAt
      : 0)
  );
}

function finishCurrentLeg(now) {
  removeMotionPath();

  /*
   * Draw the route only after the dot
   * has reached the destination.
   */
  if (currentPathData) {
    gLegs
      .append("path")
      .attr(
        "class",
        "leg-path-dim"
      )
      .attr(
        "d",
        currentPathData
      );

    trimCompletedPaths();
    currentPathData = null;
  }

  phase = "holding";
  phaseStartedAt = now;
  elapsedBeforePause = 0;
}

function advanceLeg(now) {
  setupLeg(
    currentLegIndex + 1,
    now
  );
}

function animationTick(now) {
  if (
    playing &&
    phase === "idle"
  ) {
    setupLeg(
      initialLegIndex,
      now
    );
  }

  if (
    playing &&
    phase === "flying" &&
    motionPath
  ) {
    const elapsed =
      elapsedInCurrentPhase(now);

    const rawT = Math.min(
      elapsed /
        currentLegDuration,
      1
    );

    const easedT =
      d3.easeCubicInOut(rawT);

    const point =
      motionPath.getPointAtLength(
        easedT *
          motionPathLength
      );

    marker
      .attr("cx", point.x)
      .attr("cy", point.y);

    addTrailSample(
      point,
      now
    );

    if (rawT >= 1) {
      finishCurrentLeg(now);
    }
  } else if (
    playing &&
    phase === "holding"
  ) {
    if (markerPosition) {
      addTrailSample(
        markerPosition,
        now
      );
    }

    if (
      elapsedInCurrentPhase(now) >=
      CONFIG.arrivalHoldMs
    ) {
      advanceLeg(now);
    }
  }

  drawTrail(now);

  if (
    playing ||
    trailSamples.length > 1
  ) {
    rafId =
      requestAnimationFrame(
        animationTick
      );
  } else {
    rafId = null;
  }
}

function ensureAnimationLoop() {
  if (rafId === null) {
    rafId =
      requestAnimationFrame(
        animationTick
      );
  }
}

function play() {
  if (
    playing ||
    legs.length === 0
  ) {
    return;
  }

  const now =
    performance.now();

  playing = true;
  phaseStartedAt = now;

  updateButtons();
  ensureAnimationLoop();
}

function pause() {
  if (!playing) {
    return;
  }

  const now =
    performance.now();

  elapsedBeforePause +=
    now - phaseStartedAt;

  playing = false;

  updateButtons();
  ensureAnimationLoop();
}

function restart() {
  playing = false;
  phase = "idle";

  currentLegIndex = -1;
  currentPathData = null;
  phaseStartedAt = 0;
  elapsedBeforePause = 0;

  removeMotionPath();

  gLegs
    .selectAll("*")
    .remove();

  marker
    .style("display", "none");

  markerPosition = null;

  clearTrail();
  updateButtons();

  if (legs.length > 0) {
    play();
  } else {
    legLabel.textContent =
      "No valid legs to play";
  }
}

function updateButtons() {
  playBtn.disabled =
    playing ||
    legs.length === 0;

  pauseBtn.disabled =
    !playing;
}

playBtn.addEventListener(
  "click",
  play
);

pauseBtn.addEventListener(
  "click",
  pause
);

restartBtn.addEventListener(
  "click",
  restart
);

Promise.all([
  fetchJson(MAP_URL),

  fetchText(
    "airports.txt"
  ).then(parseAirports),

  fetchText(
    "sequence.txt"
  ).then(parseSequence)
])
  .then(
    ([
      us,
      loadedAirports,
      loadedSequence
    ]) => {
      airports =
        loadedAirports;

      sequence =
        loadedSequence;

      const stateGeometries =
        us.objects.states.geometries.filter(
          (geometry) =>
            geometry.id !== "02" &&
            geometry.id !== "15"
        );

      const conus =
        topojson.merge(
          us,
          stateGeometries
        );

      projection.fitSize(
        [
          CONFIG.width,
          CONFIG.height
        ],
        conus
      );

      gMap
        .append("path")
        .datum(conus)
        .attr(
          "class",
          "us-outline"
        )
        .attr("d", geoPath);

      drawAirports();

      legs =
        buildLegs(sequence);

      initialLegIndex =
        legs.length > 0
          ? Math.floor(
              Math.random() *
                legs.length
            )
          : 0;

      console.log(
        "Airport codes read:",
        sequence.length
      );

      console.log(
        "Valid flight legs created:",
        legs.length
      );

      console.log(
        "Starting at random leg:",
        initialLegIndex + 1
      );

      if (legs.length > 0) {
        play();
      } else {
        legLabel.textContent =
          "No valid legs to play";
      }

      updateButtons();
    }
  )
  .catch((error) => {
    console.error(
      "Failed to initialize flight map:",
      error
    );

    legLabel.textContent =
      "Map failed to load";

    updateButtons();
  });
