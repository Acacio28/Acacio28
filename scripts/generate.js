import fetch from "node-fetch";
import fs from "fs";
import path from "path";

const USERNAME = process.env.GH_USERNAME || "Akashio28";
const TOKEN = process.env.GH_TOKEN;
const OUT_DIR = process.env.OUT_DIR || "./output";

if (!TOKEN) {
  console.error("Missing GH_TOKEN env var");
  process.exit(1);
}

const headers = {
  Authorization: `bearer ${TOKEN}`,
  "Content-Type": "application/json",
};

// ---------- GraphQL: contributions + repos for languages/stars ----------
const QUERY = `
query($login: String!) {
  user(login: $login) {
    name
    login
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks {
          contributionDays {
            date
            contributionCount
          }
        }
      }
    }
    repositories(first: 100, ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC) {
      totalCount
      nodes {
        name
        stargazers { totalCount }
        primaryLanguage { name color }
        languages(first: 5, orderBy: {field: SIZE, direction: DESC}) {
          edges {
            size
            node { name color }
          }
        }
      }
    }
    pullRequests(first: 1) { totalCount }
    issues(first: 1) { totalCount }
    repositoriesContributedTo(first: 1, includeUserRepositories: false) {
      totalCount
    }
  }
}
`;

async function fetchData() {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers,
    body: JSON.stringify({ query: QUERY, variables: { login: USERNAME } }),
  });
  const json = await res.json();
  if (json.errors) {
    console.error(JSON.stringify(json.errors, null, 2));
    process.exit(1);
  }
  return json.data.user;
}

// ---------- Total commits via REST search ----------
async function fetchTotalCommits() {
  const res = await fetch(
    `https://api.github.com/search/commits?q=author:${USERNAME}`,
    { headers: { ...headers, Accept: "application/vnd.github.cloak-preview" } }
  );
  const json = await res.json();
  return json.total_count || 0;
}

// ---------- Helpers ----------
function calcStreaks(days) {
  // days: array of {date, contributionCount} sorted ascending
  let longest = 0, current = 0, running = 0;
  let longestRange = ["", ""];
  let currentRange = ["", ""];
  let runStart = null;

  const today = new Date().toISOString().slice(0, 10);

  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    if (d.contributionCount > 0) {
      if (running === 0) runStart = d.date;
      running++;
      if (running > longest) {
        longest = running;
        longestRange = [runStart, d.date];
      }
    } else {
      running = 0;
    }
  }

  // current streak = trailing run up to today (allow today=0 if rest of streak still counts up to yesterday)
  running = 0;
  runStart = null;
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i];
    if (d.contributionCount > 0) {
      if (running === 0) runStart = d.date;
      running++;
    } else {
      if (d.date === today) continue; // today might just not have data yet
      break;
    }
  }
  current = running;
  if (current > 0) currentRange = [days[days.length - current]?.date || "", days[days.length - 1].date];

  return {
    longest,
    longestRange,
    current,
    currentRange,
  };
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fmtDateYear(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function rankLetter(stars, commits, prs, issues, reviews, contributed) {
  // Simplified scoring inspired by github-readme-stats ranking
  const COMMITS_MEDIAN = 250, COMMITS_WEIGHT = 2;
  const PRS_MEDIAN = 50, PRS_WEIGHT = 3;
  const ISSUES_MEDIAN = 25, ISSUES_WEIGHT = 1;
  const STARS_MEDIAN = 50, STARS_WEIGHT = 4;
  const FOLLOWERS_MEDIAN = 0, FOLLOWERS_WEIGHT = 1;

  const TOTAL_WEIGHT = COMMITS_WEIGHT + PRS_WEIGHT + ISSUES_WEIGHT + STARS_WEIGHT + FOLLOWERS_WEIGHT;

  const THRESHOLDS = [1, 12.5, 25, 37.5, 50, 62.5, 75, 87.5, 100];
  const LEVELS = ["S", "A+", "A", "A-", "B+", "B", "B-", "C+", "C"];

  function exponentialCdf(x) {
    return 1 - Math.pow(2, -x);
  }

  const score =
    (1 -
      (COMMITS_WEIGHT * exponentialCdf(commits / COMMITS_MEDIAN) +
        PRS_WEIGHT * exponentialCdf(prs / PRS_MEDIAN) +
        ISSUES_WEIGHT * exponentialCdf(issues / ISSUES_MEDIAN) +
        STARS_WEIGHT * exponentialCdf(stars / STARS_MEDIAN) +
        FOLLOWERS_WEIGHT * exponentialCdf(0)) /
        TOTAL_WEIGHT) *
    100;

  let level = LEVELS[LEVELS.length - 1];
  for (let i = 0; i < THRESHOLDS.length; i++) {
    if (score <= THRESHOLDS[i]) {
      level = LEVELS[i];
      break;
    }
  }
  return level;
}

// ---------- SVG builders ----------

function fmtNum(n) {
  return n.toLocaleString("en-US");
}

function escapeXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const COLORS = {
  bg: "#0d1117",
  border: "#30363d",
  title: "#2dd4bf", // teal
  text: "#c9d1d9",
  icon: "#58a6ff",
  accent: "#2dd4bf",
  subtext: "#8b949e",
};

function statsCardSVG({ name, stars, commits, prs, issues, contributed, rank }) {
  const width = 520, height = 195;
  const rows = [
    ["★", "Total Stars Earned:", stars],
    ["🕐", "Total Commits (last year):", commits],
    ["⇄", "Total PRs:", prs],
    ["!", "Total Issues:", issues],
    ["▣", "Contributed to (last year):", contributed],
  ];

  let rowsSvg = "";
  rows.forEach((r, i) => {
    const y = 70 + i * 24;
    rowsSvg += `
    <text x="20" y="${y}" font-size="13" fill="${COLORS.icon}" font-family="sans-serif">${r[0]}</text>
    <text x="40" y="${y}" font-size="13" font-weight="bold" fill="${COLORS.text}" font-family="sans-serif">${escapeXml(r[1])}</text>
    <text x="290" y="${y}" font-size="13" font-weight="bold" fill="${COLORS.text}" font-family="sans-serif" text-anchor="start">${r[2]}</text>`;
  });

  // rank ring
  const cx = width - 70, cy = 100, radius = 40;
  const circumference = 2 * Math.PI * radius;
  const progress = 0.85; // visual flourish, fixed arc like the example
  const dash = circumference * progress;

  return `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <style>
    text { font-family: 'Segoe UI', Ubuntu, Sans-Serif; }
  </style>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="10" fill="${COLORS.bg}" stroke="${COLORS.border}"/>
  <text x="20" y="35" font-size="17" font-weight="bold" fill="${COLORS.title}">${escapeXml(name)}'s GitHub Stats</text>
  ${rowsSvg}
  <g transform="translate(${cx}, ${cy})">
    <circle r="${radius}" fill="none" stroke="${COLORS.border}" stroke-width="5"/>
    <circle r="${radius}" fill="none" stroke="${COLORS.accent}" stroke-width="5"
      stroke-dasharray="${dash} ${circumference}" stroke-linecap="round"
      transform="rotate(-90)"/>
    <text x="0" y="6" font-size="22" font-weight="bold" fill="${COLORS.text}" text-anchor="middle">${rank}</text>
  </g>
</svg>`.trim();
}

function streakCardSVG({ total, totalRange, current, currentRange, longest, longestRange }) {
  const width = 480, height = 195;
  const colW = width / 3;

  function block(cx, value, label, range, big) {
    return `
    <text x="${cx}" y="60" font-size="36" font-weight="bold" fill="${COLORS.icon}" text-anchor="middle">${value}</text>
    <text x="${cx}" y="95" font-size="13" fill="${COLORS.text}" text-anchor="middle" font-weight="bold">${escapeXml(label)}</text>
    <text x="${cx}" y="115" font-size="11" fill="${COLORS.icon}" text-anchor="middle">${escapeXml(range)}</text>`;
  }

  const cx2 = width / 2, cy2 = 65, r2 = 38;
  const circumference = 2 * Math.PI * r2;

  return `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <style> text { font-family: 'Segoe UI', Ubuntu, Sans-Serif; } </style>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="10" fill="${COLORS.bg}" stroke="${COLORS.border}"/>
  <line x1="${colW}" y1="20" x2="${colW}" y2="${height - 20}" stroke="${COLORS.border}"/>
  <line x1="${colW * 2}" y1="20" x2="${colW * 2}" y2="${height - 20}" stroke="${COLORS.border}"/>

  ${block(colW / 2, fmtNum(total), "Total Contributions", totalRange)}

  <circle cx="${cx2}" cy="${cy2}" r="${r2}" fill="none" stroke="${COLORS.accent}" stroke-width="4"/>
  <text x="${cx2}" y="${cy2 + 8}" font-size="28" font-weight="bold" fill="${COLORS.text}" text-anchor="middle">${current}</text>
  <text x="${cx2}" y="120" font-size="13" fill="${COLORS.text}" text-anchor="middle" font-weight="bold">Current Streak</text>
  <text x="${cx2}" y="140" font-size="11" fill="${COLORS.icon}" text-anchor="middle">${escapeXml(currentRange)}</text>

  ${block(colW * 2 + colW / 2, longest, "Longest Streak", longestRange)}
</svg>`.trim();
}

function languagesAndGraphSVG({ languages, calendarDays, name }) {
  const width = 980, height = 230;

  // Languages bar + legend (left ~340px)
  const totalSize = languages.reduce((s, l) => s + l.size, 0);
  let barX = 65;
  const barY = 35, barW = 260, barH = 8;
  let bars = "";
  languages.forEach((l) => {
    const w = (l.size / totalSize) * barW;
    bars += `<rect x="${barX}" y="${barY}" width="${w}" height="${barH}" rx="4" fill="${l.color || '#999'}"/>`;
    barX += w;
  });

  let legend = "";
  const legendCols = [[0, 65], [1, 230]];
  languages.forEach((l, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = 65 + col * 165;
    const y = 70 + row * 22;
    const pct = ((l.size / totalSize) * 100).toFixed(2);
    legend += `
    <circle cx="${x}" cy="${y - 4}" r="5" fill="${l.color || '#999'}"/>
    <text x="${x + 12}" y="${y}" font-size="12" fill="${COLORS.text}">${escapeXml(l.name)} ${pct}%</text>`;
  });

  // Contribution graph (right ~600px)
  const gx = 380, gy = 30, gw = 560, gh = 150;
  const maxVal = Math.max(...calendarDays.map(d => d.contributionCount), 1);
  const stepX = gw / (calendarDays.length - 1);

  let points = "";
  calendarDays.forEach((d, i) => {
    const x = gx + i * stepX;
    const y = gy + gh - (d.contributionCount / maxVal) * gh;
    points += `${x.toFixed(2)},${y.toFixed(2)} `;
  });

  const areaPoints = `${gx},${gy + gh} ${points} ${gx + gw},${gy + gh}`;

  // gridlines for y axis (0,5,10,...rounded)
  let gridLines = "";
  const ySteps = 5;
  for (let i = 0; i <= ySteps; i++) {
    const val = Math.round((maxVal / ySteps) * i);
    const y = gy + gh - (val / maxVal) * gh;
    gridLines += `
    <line x1="${gx}" y1="${y}" x2="${gx + gw}" y2="${y}" stroke="${COLORS.border}" stroke-dasharray="2,2"/>
    <text x="${gx - 8}" y="${y + 4}" font-size="10" fill="${COLORS.subtext}" text-anchor="end">${val}</text>`;
  }

  // x-axis labels (day numbers), thin out if too many
  let xLabels = "";
  const labelEvery = Math.ceil(calendarDays.length / 30);
  calendarDays.forEach((d, i) => {
    if (i % labelEvery === 0) {
      const x = gx + i * stepX;
      const day = new Date(d.date + "T00:00:00Z").getUTCDate();
      xLabels += `<text x="${x}" y="${gy + gh + 15}" font-size="9" fill="${COLORS.subtext}" text-anchor="middle">${day}</text>`;
    }
  });

  return `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <style> text { font-family: 'Segoe UI', Ubuntu, Sans-Serif; } </style>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="10" fill="${COLORS.bg}" stroke="${COLORS.border}"/>

  <text x="20" y="28" font-size="16" font-weight="bold" fill="${COLORS.title}">Most Used Languages</text>
  ${bars}
  ${legend}

  <line x1="370" y1="20" x2="370" y2="${height - 20}" stroke="${COLORS.border}"/>

  <text x="${gx + gw / 2}" y="18" font-size="13" font-weight="bold" fill="${COLORS.title}" text-anchor="middle">${escapeXml(name)}'s Contribution Graph</text>
  ${gridLines}
  <polygon points="${areaPoints}" fill="${COLORS.accent}" fill-opacity="0.15"/>
  <polyline points="${points.trim()}" fill="none" stroke="${COLORS.accent}" stroke-width="2"/>
  ${xLabels}
  <text x="${gx + gw / 2}" y="${height - 5}" font-size="10" fill="${COLORS.subtext}" text-anchor="middle">Days</text>
  <text x="15" y="${gy + gh / 2}" font-size="10" fill="${COLORS.subtext}" text-anchor="middle" transform="rotate(-90, 15, ${gy + gh / 2})">Contributions</text>
</svg>`.trim();
}

// ---------- Main ----------
async function main() {
  const user = await fetchData();
  const commits = await fetchTotalCommits();

  // Stars: sum across owned repos
  const stars = user.repositories.nodes.reduce((s, r) => s + r.stargazers.totalCount, 0);
  const prs = user.pullRequests.totalCount;
  const issues = user.issues.totalCount;
  const contributedTo = user.repositoriesContributedTo.totalCount;

  // Languages aggregation
  const langMap = {};
  user.repositories.nodes.forEach((repo) => {
    repo.languages.edges.forEach((e) => {
      const n = e.node.name;
      if (!langMap[n]) langMap[n] = { name: n, color: e.node.color, size: 0 };
      langMap[n].size += e.size;
    });
  });
  const languages = Object.values(langMap)
    .sort((a, b) => b.size - a.size)
    .slice(0, 8);

  // Calendar days flattened
  const days = user.contributionsCollection.contributionCalendar.weeks.flatMap(
    (w) => w.contributionDays
  );
  const totalContributions = user.contributionsCollection.contributionCalendar.totalContributions;
  const totalRange = `${fmtDateYear(days[0].date)} - Present`;

  const { current, currentRange, longest, longestRange } = calcStreaks(days);

  const rank = rankLetter(stars, commits, prs, issues, 0, contributedTo);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  fs.writeFileSync(
    path.join(OUT_DIR, "stats.svg"),
    statsCardSVG({
      name: user.name || user.login,
      stars,
      commits,
      prs,
      issues,
      contributed: contributedTo,
      rank,
    })
  );

  fs.writeFileSync(
    path.join(OUT_DIR, "streak.svg"),
    streakCardSVG({
      total: totalContributions,
      totalRange,
      current,
      currentRange: current > 0 ? `${fmtDate(currentRange[0])} - ${fmtDate(currentRange[1])}` : "-",
      longest,
      longestRange: longest > 0 ? `${fmtDate(longestRange[0])} - ${fmtDate(longestRange[1])}` : "-",
    })
  );

  // Use last ~30 days for the contribution graph (matches the example's day-of-month axis)
  const recentDays = days.slice(-31);

  fs.writeFileSync(
    path.join(OUT_DIR, "activity-graph.svg"),
    languagesAndGraphSVG({
      languages,
      calendarDays: recentDays,
      name: user.name || user.login,
    })
  );

  console.log("SVGs generated in", OUT_DIR);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
