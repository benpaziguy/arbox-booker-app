"use strict";

// Talks straight to the Arbox API from your browser. There is no server of mine
// in the middle: Arbox sends `access-control-allow-origin: *`, so a static page
// can log in, read the schedule, book and cancel. That is what makes this work on
// cellular, on any network, with nothing running on a laptop.
//
// Your password is used once to get a token and is never stored. The token goes in
// sessionStorage, so it is gone when you close the tab.

const API = "https://apiappv2.arboxapp.com/api/v2";
const LOCATION_ID = 48;
const BOX_FK = "59";

// Non-secret config the portal sends on every call. `identifier` is capitalised
// differently from the URL slug -- that is Arbox's own inconsistency, not a typo.
const BASE_HEADERS = {
  "content-type": "application/json",
  whitelabel: "hypr-training",
  boxfk: BOX_FK,
  identifier: "jvswOOD31588779247",
  kiosk: "false",
  lang: "en",
  newsite: "1",
  referername: "site",
  version: "10",
};

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const TOKEN_KEY = "arbox-token";

let token = sessionStorage.getItem(TOKEN_KEY) || "";
let membershipId = null;
let classes = [];

const $ = (s) => document.querySelector(s);

// ---------------------------------------------------------------- http

async function call(path, { method = "GET", body = null, auth = true } = {}) {
  const headers = { ...BASE_HEADERS };
  if (auth) headers.accesstoken = token;
  const res = await fetch(API + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try { data = await res.json(); } catch { /* some endpoints return empty */ }

  if (res.status === 401 || res.status === 403) {
    signOut();
    throw new Error("Session expired. Sign in again.");
  }
  if (!res.ok) {
    // 425 is Arbox's "too early", and its message is the useful part.
    const msg = data?.message || data?.error || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------- auth

async function signIn(email, password) {
  const data = await call("/user/siteLogin", {
    method: "POST",
    auth: false,
    body: { email, password, phone: null },
  });
  const tok = data?.data?.token;
  if (!tok) throw new Error("No token in the login response.");
  token = tok;
  sessionStorage.setItem(TOKEN_KEY, token);
}

// Header controls only make sense once there is a session, so they follow the gate.
function showSignedIn(yes) {
  $("#gate").classList.toggle("hidden", yes);
  $("#main").classList.toggle("hidden", !yes);
  $("#tools").classList.toggle("hidden", !yes);
  $("#refresh").classList.toggle("hidden", !yes);
  $("#signout").classList.toggle("hidden", !yes);
}

function signOut() {
  token = "";
  membershipId = null;
  sessionStorage.removeItem(TOKEN_KEY);
  showSignedIn(false);
}

// Which membership pays. Chosen by RULE, not by a hardcoded id: an unlimited plan
// (mt_type "plan", no session counter) is the safe pick. The alternative on this
// account is a session pack with 0 sessions left and a card on file, and spending
// that could attempt a charge -- so anything with sessions_left === 0 is rejected
// outright, and an ambiguous result asks rather than guesses.
async function resolveMembership() {
  const data = await call(`/boxes/${BOX_FK}/memberships/true`);
  const rows = (data?.data || []).filter((r) => r.active);
  if (!rows.length) throw new Error("No active membership on this account.");

  const usable = rows.filter((r) => r.sessions_left === null || r.sessions_left > 0);
  if (!usable.length) {
    throw new Error("No membership with sessions left. Book on the Arbox site instead.");
  }
  const plan = usable.find((r) => r.mt_type === "plan");
  const chosen = plan || usable[0];
  membershipId = chosen.id;

  if (!plan) {
    toast(`Using a ${chosen.mt_type} membership (no unlimited plan found).`, "warn");
  }
  return membershipId;
}

// ---------------------------------------------------------------- schedule

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Registration opens 72h before Sunday and Monday classes, 48h otherwise -- but
// the API reports the real figure per class, so trust that and only fall back.
function windowHours(row, startsAt) {
  const reported = Number(row.enable_registration_time);
  if (Number.isFinite(reported) && reported > 0) return reported;
  const dow = startsAt.getDay(); // 0=Sun, 1=Mon
  return dow === 0 || dow === 1 ? 72 : 48;
}

// Names live in nested objects on some rows and as plain strings on others.
function text(value) {
  if (value && typeof value === "object") {
    return String(value.name || value.full_name || value.location || "");
  }
  return String(value ?? "");
}

function parseRow(row) {
  const date = String(row.date).slice(0, 10);
  const start = String(row.time || row.start_time || "").slice(0, 5);
  const startsAt = new Date(`${date}T${start}:00`);
  const registered = Number(row.registered ?? 0);
  const limit = Number(row.max_users ?? 0);
  return {
    id: row.id,
    date,
    start,
    name: (text(row.box_categories) || text(row.name) || "Class").trim(),
    coach: (text(row.coach) || text(row.coach_name)).trim(),
    registered,
    limit,
    standby: Number(row.stand_by ?? 0),
    isFull: limit > 0 && registered >= limit,
    spotsLeft: Math.max(0, limit - registered),
    bookedByMe: !!row.user_booked,
    inStandby: !!row.user_in_standby,
    // Cancelling needs the id of the BOOKING, not of the class. Arbox puts it in
    // user_booked (and user_in_standby for a waiting-list place). Without it,
    // scheduleUser/delete returns a cheerful 200 and cancels nothing.
    scheduleUserId: row.user_booked || row.user_in_standby || null,
    isPast: !!row.past || startsAt < new Date(),
    startsAt,
    opensAt: new Date(startsAt.getTime() - windowHours(row, startsAt) * 3600 * 1000),
  };
}

async function loadSchedule() {
  const from = new Date();
  const to = new Date(from.getTime() + 14 * 86400 * 1000);
  const data = await call("/schedule/betweenDates", {
    method: "POST",
    body: { from: ymd(from), to: ymd(to), locations_box_id: LOCATION_ID },
  });
  classes = (data?.data || []).map(parseRow).filter((c) => !c.isPast);
  classes.sort((a, b) => a.startsAt - b.startsAt);
  render();
}

// ---------------------------------------------------------------- booking

async function book(cls, viaWaitlist) {
  if (!membershipId) await resolveMembership();
  await call("/scheduleUser/insert", {
    method: "POST",
    // Verified against what the real portal sends. `membership_user_id` -- the
    // schedule rows call the same concept membership_user_fk, which is wrong here.
    body: { extras: null, membership_user_id: membershipId, schedule_id: cls.id },
  });

  // Don't trust the 200 alone: re-read and confirm the seat is really ours. A
  // cancellation taught us these endpoints can answer 200 and do nothing.
  await loadSchedule();
  const now = classes.find((c) => c.id === cls.id);
  if (now && !now.bookedByMe && !now.inStandby) {
    throw new Error("Arbox accepted the request but you are not on the list.");
  }
  const waitlisted = viaWaitlist || (now && now.inStandby && !now.bookedByMe);
  toast(waitlisted ? `On the waiting list for ${cls.name}.` : `Booked ${cls.name} at ${cls.start}.`, "ok");
}

async function cancel(cls) {
  // Verified against the real portal: delete needs schedule_user_id AND
  // schedule_id. Sending schedule_id alone returns HTTP 200 and cancels nothing,
  // so refuse rather than report a success that did not happen.
  if (!cls.scheduleUserId) {
    throw new Error("Cannot find this booking's id. Refresh and try again.");
  }

  // Arbox asks checkLateCancel first; its answer decides whether the cancellation
  // counts as late. It returns 200 regardless, so it is advisory, not a result.
  let late = false;
  try {
    const check = await call("/scheduleUser/checkLateCancel", {
      method: "POST",
      body: { schedule_id: cls.id },
    });
    late = !!(check?.data?.late_cancel ?? check?.late_cancel);
  } catch {
    // Non-fatal: fall through with late_cancel false, exactly as the portal does.
  }

  await call("/scheduleUser/delete", {
    method: "POST",
    body: { schedule_user_id: cls.scheduleUserId, schedule_id: cls.id, late_cancel: late },
  });

  // The 200 above is necessary but not sufficient, so confirm from the server.
  await loadSchedule();
  const still = classes.find((c) => c.id === cls.id);
  if (still && (still.bookedByMe || still.inStandby)) {
    throw new Error("Arbox accepted the request but the booking is still there.");
  }
  toast(`Cancelled ${cls.name} at ${cls.start}.`, "ok");
}

async function act(cls, kind, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "…";
  try {
    if (kind === "cancel") await cancel(cls);
    else await book(cls, kind === "waitlist");
    await loadSchedule();
  } catch (err) {
    // 425 means the window is not open yet; Arbox's own wording is clearer here.
    toast(err.message, "bad");
    button.disabled = false;
    button.textContent = original;
  }
}

// ---------------------------------------------------------------- render

function card(cls) {
  const el = document.createElement("div");
  el.className = "card" + (cls.bookedByMe ? " booked" : "") + (cls.isFull ? " full" : "");

  const time = document.createElement("div");
  time.className = "time";
  time.textContent = cls.start;

  const meta = document.createElement("div");
  meta.className = "meta";
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = cls.name;
  const sub = document.createElement("div");
  sub.className = "sub";

  let detail = `${cls.registered}/${cls.limit}`;
  if (cls.isFull && cls.standby) detail += ` · ${cls.standby} waiting`;
  else if (!cls.isFull) detail += ` · ${cls.spotsLeft} free`;
  if (cls.coach) detail += ` · ${cls.coach}`;
  const open = cls.opensAt <= new Date();
  if (!open) {
    detail += ` · opens ${DAYS[(cls.opensAt.getDay() + 6) % 7].slice(0, 3)} ` +
      `${cls.opensAt.getHours()}:${String(cls.opensAt.getMinutes()).padStart(2, "0")}`;
  }
  sub.textContent = detail;
  meta.append(name, sub);

  const btn = document.createElement("button");
  if (cls.bookedByMe) {
    btn.className = "btn danger";
    btn.textContent = "Cancel";
    btn.onclick = () => act(cls, "cancel", btn);
  } else if (cls.inStandby) {
    btn.className = "btn ghost";
    btn.textContent = "waiting";
    btn.disabled = true;
  } else if (!open) {
    // Tapping now would be refused with a 425, so say so instead.
    btn.className = "btn ghost";
    btn.textContent = "Too early";
    btn.disabled = true;
  } else if (cls.isFull) {
    btn.className = "btn ghost";
    btn.textContent = "Waitlist";
    btn.onclick = () => act(cls, "waitlist", btn);
  } else {
    btn.className = "btn";
    btn.textContent = "Book";
    btn.onclick = () => act(cls, "book", btn);
  }

  el.append(time, meta, btn);
  return el;
}

function render() {
  const host = $("#list");
  host.textContent = "";
  const filter = $("#filter").value.trim().toLowerCase();
  const mineOnly = $("#mine-only").checked;

  const shown = classes.filter((c) => {
    if (mineOnly && !c.bookedByMe && !c.inStandby) return false;
    return !filter || c.name.toLowerCase().includes(filter);
  });

  if (!shown.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = mineOnly ? "You are not booked on anything." : "Nothing matches.";
    host.append(p);
    return;
  }

  let day = null;
  const today = ymd(new Date());
  for (const cls of shown) {
    if (cls.date !== day) {
      day = cls.date;
      const h = document.createElement("div");
      h.className = "day-title";
      const d = new Date(day + "T00:00:00");
      h.textContent = (day === today ? "Today · " : "") +
        `${DAYS[(d.getDay() + 6) % 7]} ${d.getDate()}/${d.getMonth() + 1}`;
      host.append(h);
    }
    host.append(card(cls));
  }
}

function toast(message, kind) {
  const el = $("#toast");
  el.textContent = message;
  el.className = "toast" + (kind ? " " + kind : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), kind === "bad" ? 9000 : 5000);
}

// ---------------------------------------------------------------- wiring

async function start() {
  showSignedIn(true);
  try {
    await loadSchedule();
    await resolveMembership();
  } catch (err) {
    toast(err.message, "bad");
  }
}

$("#signin").onclick = async () => {
  const email = $("#email").value.trim();
  const password = $("#password").value;
  if (!email || !password) return;
  const btn = $("#signin");
  btn.disabled = true;
  btn.textContent = "Signing in…";
  try {
    await signIn(email, password);
    if ($("#remember").checked) localStorage.setItem("arbox-email", email);
    await start();
  } catch (err) {
    toast(err.message, "bad");
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
};

$("#password").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#signin").click(); });
$("#filter").addEventListener("input", render);
$("#mine-only").addEventListener("change", render);
$("#refresh").onclick = () => loadSchedule().catch((e) => toast(e.message, "bad"));
$("#signout").onclick = signOut;

$("#email").value = localStorage.getItem("arbox-email") || "";

// A token in sessionStorage means this tab was already signed in.
if (token) start(); else showSignedIn(false);
