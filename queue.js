"use strict";

// Queueing a class from the phone, with nothing of mine running anywhere.
//
// This is the one thing the gym's own site cannot do: ask for a class now and have
// it claimed the instant registration opens, days later, while you are asleep.
// Something has to act at that moment, and it cannot be this page -- a phone
// browser is not awake at 03:00. GitHub Actions is.
//
// So the page does not book the class; it writes the request into schedule.json in
// the private repo, using the GitHub contents API straight from the browser.
// api.github.com sends `access-control-allow-origin: *` and allows the
// Authorization header, so no server of mine is involved here either.
//
// The token is a fine-grained PAT with Contents: read and write on that one repo,
// and nothing else. It is kept in localStorage on the phone, which is the honest
// trade: a static page has nowhere else to put it. Scope it to the one repository
// so a stolen phone cannot touch anything but this schedule.

const GH_API = "https://api.github.com";
const GH_TOKEN_KEY = "arbox-gh-token";
const GH_REPO_KEY = "arbox-gh-repo";
const SCHEDULE_PATH = "schedule.json";

// Prefilled so setup is one field instead of two. This is a repository NAME, not a
// credential: the repo is private, and knowing its name grants nothing without a
// token. The token is the only secret, and it never ships in this file -- the page
// is served from a public repo, so anything committed here is world-readable.
const DEFAULT_REPO = "benpaziguy/arbox-booker";

let ghToken = localStorage.getItem(GH_TOKEN_KEY) || "";
let ghRepo = localStorage.getItem(GH_REPO_KEY) || DEFAULT_REPO;

function queueConfigured() {
  return !!(ghToken && ghRepo);
}

function saveQueueConfig(repo, tok) {
  ghRepo = repo.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\/+$/, "");
  ghToken = tok.trim();
  localStorage.setItem(GH_REPO_KEY, ghRepo);
  localStorage.setItem(GH_TOKEN_KEY, ghToken);
}

function forgetQueueConfig() {
  ghToken = "";
  ghRepo = DEFAULT_REPO;
  localStorage.removeItem(GH_TOKEN_KEY);
  localStorage.removeItem(GH_REPO_KEY);
}

async function gh(path, { method = "GET", body = null } = {}) {
  const res = await fetch(GH_API + path, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${ghToken}`,
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try { data = await res.json(); } catch { /* 204 has no body */ }

  if (!res.ok) {
    // Map the failures that actually happen to what to do about them. The bare
    // GitHub message ("Not Found" for a token missing a scope) sends you hunting
    // in the wrong place.
    if (res.status === 401) throw new Error("GitHub rejected the token. Paste a new one in Queue settings.");
    if (res.status === 404) {
      throw new Error(`Cannot see ${ghRepo}. Check the name, and that the token grants ` +
        `Contents access to that repository.`);
    }
    if (res.status === 403 && (data?.message || "").includes("rate limit")) {
      throw new Error("GitHub rate limit reached. Try again in a few minutes.");
    }
    if (res.status === 403) throw new Error("The token lacks Contents: read and write on this repository.");
    if (res.status === 409) throw new Error("The schedule changed while saving. Try again.");
    throw new Error(data?.message || `GitHub HTTP ${res.status}`);
  }
  return data;
}

// UTF-8 safe base64. A class name with a non-ASCII character would make plain
// btoa() throw, and the schedule is written with ensure_ascii=False.
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function fetchSchedule() {
  const file = await gh(`/repos/${ghRepo}/contents/${SCHEDULE_PATH}`);
  const doc = JSON.parse(b64decode(file.content));
  return { doc, sha: file.sha };
}

// The sha is passed back on write, so GitHub rejects the update if the file changed
// underneath us -- the scheduler's own --prune, or an edit from the Mac. Better a
// 409 the user can retry than silently reverting someone else's change.
async function putSchedule(doc, sha, message) {
  await gh(`/repos/${ghRepo}/contents/${SCHEDULE_PATH}`, {
    method: "PUT",
    body: {
      message,
      content: b64encode(JSON.stringify(doc, null, 2) + "\n"),
      sha,
    },
  });
}

function onceId(cls, existing) {
  const base = `${cls.date}-${cls.start.replace(":", "")}`;
  const taken = new Set((existing || []).map((r) => String(r.id)));
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

// Mirrors scheduler.queue_once: same id shape, same duplicate rule, same fields.
// The two must agree, because the Python side validates whatever this writes and a
// rejected document would stop the automation booking anything at all.
async function queueClass(cls, waitlist) {
  if (!queueConfigured()) throw new Error("Set up queueing first (⚙ Queue).");

  const { doc, sha } = await fetchSchedule();
  const once = Array.isArray(doc.once) ? doc.once : [];

  const clash = once.find((r) =>
    String(r.date) === cls.date &&
    String(r.time || "").slice(0, 5) === cls.start &&
    String(r.class_name || "").trim().toLowerCase() === cls.name.toLowerCase());
  if (clash) throw new Error(`Already queued as ${clash.id}.`);

  const entry = {
    id: onceId(cls, once),
    date: cls.date,
    time: cls.start,
    class_name: cls.name,
    waitlist: !!waitlist,
    enabled: true,
  };
  doc.once = [...once, entry];
  await putSchedule(doc, sha, `Queue ${cls.name} ${cls.start} on ${cls.date}`);
  return entry;
}

async function unqueueId(id) {
  const { doc, sha } = await fetchSchedule();
  const once = Array.isArray(doc.once) ? doc.once : [];
  const keep = once.filter((r) => String(r.id) !== String(id));
  if (keep.length === once.length) return null;
  const removed = once.find((r) => String(r.id) === String(id));
  doc.once = keep;
  await putSchedule(doc, sha, `Unqueue ${removed.class_name} on ${removed.date}`);
  return removed;
}

// ------------------------------------------------------- recurring rules

// The page renders live Arbox classes, which carry no trace of why they were
// booked, so a seat a weekly rule claimed looks exactly like one booked by hand.
// That difference matters for exactly one reason: cancelling a class a rule wants
// hands it straight back, and the next run books it again. Matching the rule here
// is what lets the cancel path say "and not next time either".
//
// Matched on weekday + time + name, the same three fields scheduler.load_rules
// validates. Not on id, because the page never sees which rule booked a class.
function rulesFor(doc) {
  return Array.isArray(doc.rules) ? doc.rules : [];
}

function isoWeekday(ymdStr) {
  const d = new Date(ymdStr + "T00:00:00");
  return d.getDay() === 0 ? 7 : d.getDay();   // JS Sunday is 0; ISO Sunday is 7
}

function matchRule(rules, cls) {
  // Both sides trimmed and lowercased, matching scheduler.stand_down. The class
  // name arrives trimmed from parseRow, but relying on that would make the two
  // implementations disagree the day it changes.
  const want = String(cls.name || "").trim().toLowerCase();
  return rules.find((r) =>
    Number(r.weekday) === isoWeekday(cls.date) &&
    String(r.time || "").slice(0, 5) === cls.start &&
    String(r.class_name || "").trim().toLowerCase() === want &&
    r.enabled !== false) || null;
}

// Which recurring rule, if any, will try to book this class -- and whether that
// date is already being skipped. One fetch, so a card can be rendered without
// three round trips.
async function ruleStateFor(cls) {
  if (!queueConfigured()) return { rule: null, skipped: false };
  const { doc } = await fetchSchedule();
  const rule = matchRule(rulesFor(doc), cls);
  if (!rule) return { rule: null, skipped: false };
  const skips = Array.isArray(doc.skip) ? doc.skip : [];
  const skipped = skips.some((s) =>
    s && String(s.rule) === String(rule.id) && String(s.date) === cls.date);
  return { rule, skipped };
}

// Mirrors scheduler.add_skip / remove_skip, including the {rule, date} shape --
// the Python side validates whatever this writes.
async function setSkip(ruleId, date, skip) {
  const { doc, sha } = await fetchSchedule();
  const skips = Array.isArray(doc.skip) ? doc.skip : [];
  const has = skips.some((s) => s && String(s.rule) === String(ruleId) && String(s.date) === date);
  if (skip === has) return false;
  doc.skip = skip
    ? [...skips, { rule: ruleId, date }]
    : skips.filter((s) => !(s && String(s.rule) === String(ruleId) && String(s.date) === date));
  await putSchedule(doc, sha,
    `${skip ? "Skip" : "Unskip"} ${ruleId} on ${date}`);
  return true;
}

async function listQueued() {
  const { doc } = await fetchSchedule();
  const once = Array.isArray(doc.once) ? doc.once : [];
  return once.slice().sort((a, b) =>
    String(a.date + a.time).localeCompare(String(b.date + b.time)));
}

// Everything the renderer needs about the schedule, in one request. Rendering a
// card must not depend on a fetch per card: the list is ~100 classes over a
// fortnight, and GitHub rate-limits.
async function loadScheduleState() {
  const { doc } = await fetchSchedule();
  return {
    once: Array.isArray(doc.once) ? doc.once : [],
    rules: rulesFor(doc),
    skips: Array.isArray(doc.skip) ? doc.skip : [],
  };
}
