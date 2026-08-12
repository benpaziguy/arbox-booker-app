"use strict";

// Queueing a class from the phone, with nothing of mine running on a laptop.
//
// This is the one thing the gym's own site cannot do: ask for a class now and have
// it claimed the instant registration opens, days later, while you are asleep.
// Something has to act at that moment, and it cannot be this page -- a phone
// browser is not awake at 03:00. GitHub Actions is (for now; the scheduler runs
// there and reads the same store).
//
// The page does not book the class; it writes the request into the shared schedule
// held in Cloudflare KV, through the arbox-kv Worker. Why the Worker and not KV
// directly: Cloudflare's KV REST API sends no CORS headers, so a browser cannot
// call it -- verified with a preflight that returned 405 and no allow-origin. The
// Worker sets its own CORS and holds the KV binding, so no KV token is in this
// page. It gates every read/write on a shared secret in the x-app-secret header.
//
// The secret is the only credential, kept in localStorage -- the honest trade for
// a static page. It never ships in this file (served from a public repo, so
// anything here is world-readable). It guards only the schedule store: not the
// Arbox login, not the KV admin token. Rotate it on the Worker if a phone is lost.
//
// Multi-user note (Rung 5): today there is one schedule and one secret. When users
// log in, the Worker will key KV per user from their identity and this "paste a
// secret" step becomes "log in" -- the transport below does not change, only where
// the secret comes from.

const WORKER_URL_KEY = "arbox-worker-url";
const APP_SECRET_KEY = "arbox-app-secret";

// Prefilled so setup is one field. This is a public URL, not a credential: hitting
// it without the secret gets a 401. The secret is what matters, and it is never
// committed here.
const DEFAULT_WORKER_URL = "https://arbox-kv.benpaziguy.workers.dev";

let workerUrl = localStorage.getItem(WORKER_URL_KEY) || DEFAULT_WORKER_URL;
let appSecret = localStorage.getItem(APP_SECRET_KEY) || "";

function queueConfigured() {
  return !!(workerUrl && appSecret);
}

function saveQueueConfig(url, secret) {
  workerUrl = (url || DEFAULT_WORKER_URL).trim().replace(/\/+$/, "");
  appSecret = (secret || "").trim();
  localStorage.setItem(WORKER_URL_KEY, workerUrl);
  localStorage.setItem(APP_SECRET_KEY, appSecret);
}

function forgetQueueConfig() {
  workerUrl = DEFAULT_WORKER_URL;
  appSecret = "";
  localStorage.setItem(WORKER_URL_KEY, workerUrl);
  localStorage.removeItem(APP_SECRET_KEY);
}

async function worker(path, { method = "GET", body = null } = {}) {
  const res = await fetch(workerUrl + path, {
    method,
    headers: {
      "x-app-secret": appSecret,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try { data = await res.json(); } catch { /* some responses have no body */ }

  if (!res.ok) {
    // Map the failures that actually happen to what to do about them.
    if (res.status === 401) {
      throw new Error("The app secret is wrong or missing. Paste it again in ⚙ Queue.");
    }
    if (res.status === 404 && /no schedule/i.test(data?.error || "")) {
      throw new Error("No schedule is stored yet. Seed it from the Mac (migrate_schedule.py) first.");
    }
    if (res.status === 422) throw new Error("The schedule change was rejected as malformed.");
    if (res.status === 0 || res.status >= 500) {
      throw new Error(`The schedule service is unreachable (HTTP ${res.status}). Try again.`);
    }
    throw new Error(data?.error || `Schedule service HTTP ${res.status}`);
  }
  return data;
}

async function fetchSchedule() {
  const doc = await worker("/schedule");
  // sha kept in the shape for callers that still pass it back to putSchedule; the
  // Worker does not use optimistic concurrency, so it is always null. (The phone is
  // effectively the only interactive writer; the scheduler mostly reads. A future
  // revision could add an ETag if concurrent writers become common.)
  return { doc, sha: null };
}

// sha and message are accepted for signature parity with the old GitHub path but
// not used: the Worker keys off the single "schedule" entry and needs no commit
// message. Last-write-wins, which for one phone is fine and still removes the git
// push races that motivated the move.
async function putSchedule(doc, _sha, _message) {
  await worker("/schedule", { method: "PUT", body: doc });
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
