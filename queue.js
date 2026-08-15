"use strict";

// Queueing and weekly rules from the phone, with nothing of ours on the phone.
//
// This is the thing the gym's own site cannot do: ask for a class now and have it
// claimed the instant registration opens, days later, at 03:00. A phone browser is
// asleep then, so the booking runs elsewhere (the scheduler, in GitHub Actions) --
// this page only records what each user wants.
//
// The page talks to our Cloudflare Worker over HTTPS: /signup and /login (verified
// first against Arbox by arbox.js, so only real members get in), then /schedule and
// /creds and /account, all authorised by a SESSION TOKEN in the Authorization:
// Bearer header. The Worker holds the D1 binding and stores each user's schedule and
// their encrypted Arbox password; nothing sensitive lives in this file (it is served
// from a public repo). The session token is kept in localStorage -- the honest trade
// for a static page -- and is the only thing on the device; losing the phone risks
// only this account's schedule, and signing out or deleting the account clears it.
//
// One credential (Rung 5): the account IS the gym login. There is no separate app
// password and no shared secret -- signing in with the gym email+password is what
// authorises everything below.

const WORKER_URL_KEY = "arbox-worker-url";
const SESSION_KEY = "arbox-session";

// Prefilled so setup is one field. This is a public URL, not a credential: every
// data route needs a valid session token, which comes from logging in.
const DEFAULT_WORKER_URL = "https://arbox-next.benpaziguy.workers.dev";

// A phone that used the old single-user app has the OLD worker URL cached in
// localStorage; that Worker has no /signup, so a stored old-default must not stick.
// Ignore any stored URL that is a retired single-user host, falling back to the
// current default. A user who deliberately set a custom URL still keeps it. Kept as
// a one-line assignment so tests that stub via a regex on this line stay simple.
const RETIRED_WORKER_URLS = ["https://arbox-kv.benpaziguy.workers.dev"];
function pickWorkerUrl(stored) { return stored && !RETIRED_WORKER_URLS.includes(stored) ? stored : DEFAULT_WORKER_URL; }
let workerUrl = pickWorkerUrl(localStorage.getItem(WORKER_URL_KEY));
let sessionToken = localStorage.getItem(SESSION_KEY) || "";

// "Configured" now means "signed in". The session token authorises every data
// call; there is no separate app secret any more (Rung 5 -- one credential).
function queueConfigured() {
  return !!(workerUrl && sessionToken);
}

function setSession(token) {
  sessionToken = (token || "").trim();
  if (sessionToken) localStorage.setItem(SESSION_KEY, sessionToken);
  else localStorage.removeItem(SESSION_KEY);
}

function forgetQueueConfig() {
  setSession("");
}

// Sign up (create the account) or sign in. The phone has ALREADY verified the
// email+password against Arbox before calling these (see arbox.js signIn), so the
// Worker's signup gate is simply "the account does not exist yet".
async function signUpWorker(email, password) {
  const data = await worker("/signup", { method: "POST", auth: false,
    body: { email, password } });
  setSession(data.token);
  return data;
}

async function signInWorker(email, password) {
  const data = await worker("/login", { method: "POST", auth: false,
    body: { email, password } });
  setSession(data.token);
  return data;
}

async function signOutWorker() {
  try { if (sessionToken) await worker("/logout", { method: "POST" }); }
  catch { /* revoking is best-effort; clearing locally is what matters */ }
  setSession("");
}

// Delete the account and everything it owns (rules, one-offs, skips, stored Arbox
// credentials, sessions). Irreversible; the caller confirms first. Clears the local
// session afterward since it no longer exists server-side.
async function deleteAccountWorker() {
  await worker("/account", { method: "DELETE" });
  setSession("");
}

// ---------------------------------------------------------------- feedback
//
// Post a bug report or feature request to the Worker (POST /feedback), which stores
// it in D1 for the operator to read. Session-scoped: the Worker attributes it to the
// signed-in user from the bearer token, so nothing about identity is sent in the body.
async function submitFeedback(kind, message) {
  await worker("/feedback", { method: "POST", body: { kind, message } });
}

// ---------------------------------------------------------------- web push
//
// "Notify me when a class is booked." The browser subscribes to its push service
// using the server's VAPID public key; we send that subscription to the Worker,
// which stores it per user. The scheduler later pushes to it. All of this is
// gated on real support -- and on iOS specifically, on the app being installed to
// the Home Screen (see pushSupport()).

function base64UrlToUint8Array(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// What the current device can do, so the UI can explain rather than silently fail.
//   "ok"        -> push is available now
//   "ios-home"  -> iOS Safari, but only works once Added to Home Screen
//   "unsupported" -> this browser can't do web push at all
function pushSupport() {
  const hasApi = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
  // iOS only fires push for an installed PWA (standalone display mode).
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches
    || window.navigator.standalone === true;
  if (isIOS && !standalone) return "ios-home";
  if (!hasApi) return "unsupported";
  return "ok";
}

async function pushEnabled() {
  if (pushSupport() !== "ok") return false;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && (await reg.pushManager.getSubscription());
  return !!sub;
}

// Subscribe this device and register it with the Worker. Returns true on success.
async function enablePush() {
  if (pushSupport() !== "ok") throw new Error("Notifications aren't available on this device.");
  const { vapid_public_key } = await worker("/config", { auth: false });
  if (!vapid_public_key) throw new Error("Notifications are not configured on the server yet.");

  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notifications were not allowed.");

  const reg = await navigator.serviceWorker.register("sw.js");
  await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToUint8Array(vapid_public_key),
  });
  await worker("/push", { method: "POST", body: { subscription: sub.toJSON() } });
  return true;
}

async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && (await reg.pushManager.getSubscription());
  if (sub) {
    // Tell the Worker first (so a failed unsubscribe doesn't orphan the row), then
    // drop the browser subscription.
    try { await worker("/push", { method: "DELETE", body: { endpoint: sub.endpoint } }); } catch { /* ignore */ }
    await sub.unsubscribe();
  }
}

async function worker(path, { method = "GET", body = null, auth = true } = {}) {
  const headers = { ...(body ? { "content-type": "application/json" } : {}) };
  if (auth && sessionToken) headers["authorization"] = `Bearer ${sessionToken}`;
  const res = await fetch(workerUrl + path, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try { data = await res.json(); } catch { /* some responses have no body */ }

  if (!res.ok) {
    // Map the failures that actually happen to what to do about them.
    if (res.status === 401) {
      // On a data call this means the session expired; force a fresh sign-in.
      if (auth) setSession("");
      throw new Error(data?.error || "Please sign in again.");
    }
    if (res.status === 404 && /no schedule/i.test(data?.error || "")) {
      throw new Error("No schedule for this account yet.");
    }
    if (res.status === 409) throw new Error(data?.error || "That account already exists.");
    if (res.status === 422) throw new Error(data?.error || "The request was rejected as malformed.");
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

// A stable rule id from the slot, mirroring the ids already in schedule.json
// (e.g. "tue-2000-wod"): weekday abbrev + HHMM + a slug of the class name.
function newRuleId(cls) {
  const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const d = new Date(cls.date + "T00:00:00").getDay();
  const hhmm = cls.start.replace(":", "");
  const slug = String(cls.name || "").trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "class";
  return `${days[d]}-${hhmm}-${slug}`;
}

// Add a weekly recurring rule for this class's weekday + time + class name. No-op
// (returns the existing rule) if one already matches, so a double tap is safe.
// waitlist defaults true, matching the existing rules. Mirrors the rule shape
// scheduler.load_rules validates.
async function addRule(cls, waitlist = true) {
  const { doc, sha } = await fetchSchedule();
  const rules = rulesFor(doc);
  const existing = matchRule(rules, cls);
  if (existing) return existing;

  const taken = new Set(rules.map((r) => String(r.id)));
  let id = newRuleId(cls);
  for (let n = 2; taken.has(id); n++) id = `${newRuleId(cls)}-${n}`;

  const rule = {
    id,
    weekday: isoWeekday(cls.date),
    time: cls.start,
    class_name: cls.name,
    waitlist: !!waitlist,
    enabled: true,
  };
  doc.rules = [...rules, rule];
  await putSchedule(doc, sha, `Add weekly ${cls.name} ${cls.start}`);
  return rule;
}

// Remove the weekly rule that owns this class (matched on weekday+time+name), and
// any skip rows for it. Returns the removed rule, or null if none matched.
async function removeRule(cls) {
  const { doc, sha } = await fetchSchedule();
  const rules = rulesFor(doc);
  const rule = matchRule(rules, cls);
  if (!rule) return null;
  doc.rules = rules.filter((r) => String(r.id) !== String(rule.id));
  // A skip only makes sense with its rule; drop orphans so they cannot linger.
  const skips = Array.isArray(doc.skip) ? doc.skip : [];
  doc.skip = skips.filter((s) => !(s && String(s.rule) === String(rule.id)));
  await putSchedule(doc, sha, `Stop weekly ${cls.name} ${cls.start}`);
  return rule;
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
