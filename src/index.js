/**
 * Jarvi → Google Calendar sync
 * Cloudflare Worker.
 *
 * - Cron (voir wrangler.toml) : synchronisation automatique.
 * - HTTP GET /sync?secret=... : déclenchement manuel (utile pour tester).
 * - HTTP GET /            : page d'info / santé.
 *
 * Chaque rappel Jarvi (todo) devient un événement Google Calendar.
 * La déduplication se fait via extendedProperties.private.jarviTodoId :
 * on ne recrée jamais un événement déjà présent, on le met à jour s'il a changé.
 */

const PRIORITY_RANK = { P1: 1, P2: 2, P3: 3, P4: 4 };

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSync(env).then((r) => console.log("Sync cron terminée", r)));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/sync") {
      const secret = url.searchParams.get("secret");
      if (!env.SYNC_SECRET || secret !== env.SYNC_SECRET) {
        return json({ error: "Unauthorized" }, 401);
      }
      try {
        const result = await runSync(env);
        return json({ ok: true, ...result });
      } catch (err) {
        console.error(err);
        return json({ ok: false, error: String(err && err.message || err) }, 500);
      }
    }

    return json({
      service: "jarvi-gcal-sync",
      status: "ok",
      hint: "Déclenchement manuel : GET /sync?secret=VOTRE_SYNC_SECRET",
    });
  },
};

/** Orchestration complète d'une synchronisation. */
async function runSync(env) {
  const cfg = readConfig(env);
  const todos = await fetchJarviTodos(env, cfg);
  const accessToken = await getGoogleAccessToken(env);

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const errors = [];

  for (const todo of todos) {
    try {
      const desired = buildEvent(todo, cfg);
      const existing = await findEventByTodoId(accessToken, cfg.calendarId, todo.id);

      if (!existing) {
        await createEvent(accessToken, cfg.calendarId, desired);
        created++;
      } else if (eventNeedsUpdate(existing, desired)) {
        await patchEvent(accessToken, cfg.calendarId, existing.id, desired);
        updated++;
      } else {
        skipped++;
      }
    } catch (err) {
      errors.push({ todoId: todo.id, error: String(err && err.message || err) });
    }
  }

  return { totalTodos: todos.length, created, updated, skipped, errors };
}

/** Lecture / validation de la configuration. */
function readConfig(env) {
  const required = [
    "JARVI_GRAPHQL_URL",
    "JARVI_AUTH_TOKEN",
    "JARVI_USER_ID",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REFRESH_TOKEN",
  ];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error("Secrets manquants : " + missing.join(", "));
  }
  return {
    timezone: env.TIMEZONE || "Europe/Paris",
    durationMinutes: parseInt(env.EVENT_DURATION_MINUTES || "30", 10),
    calendarId: env.CALENDAR_ID || "primary",
    titlePrefix: env.EVENT_TITLE_PREFIX || "Jarvi · ",
    onlyUpcoming: (env.ONLY_UPCOMING || "true") === "true",
    minPriority: env.MIN_PRIORITY || "P4",
  };
}

/* ------------------------------------------------------------------ */
/* Jarvi                                                               */
/* ------------------------------------------------------------------ */

async function fetchJarviTodos(env, cfg) {
  const query = `
    query SyncTodos($uid: uuid!, $after: timestamptz) {
      todos(
        where: {
          ownedByUserId: { _eq: $uid }
          doneAt: { _is_null: true }
          deletedAt: { _is_null: true }
          scheduledAt: { _is_null: false, _gte: $after }
        }
        order_by: { scheduledAt: asc }
        limit: 500
      ) {
        id
        title
        scheduledAt
        priority
        mentions {
          profile { firstName lastName }
          company { name }
          project { name }
        }
      }
    }`;

  // _gte ignoré si onlyUpcoming = false (on remonte loin dans le passé).
  const after = cfg.onlyUpcoming
    ? new Date().toISOString()
    : "1970-01-01T00:00:00Z";

  const res = await fetch(env.JARVI_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: env.JARVI_AUTH_TOKEN.startsWith("Bearer ")
        ? env.JARVI_AUTH_TOKEN
        : "Bearer " + env.JARVI_AUTH_TOKEN,
    },
    body: JSON.stringify({
      query,
      variables: { uid: env.JARVI_USER_ID, after },
    }),
  });

  if (!res.ok) {
    throw new Error("Jarvi HTTP " + res.status + " : " + (await res.text()));
  }
  const data = await res.json();
  if (data.errors) {
    throw new Error("Jarvi GraphQL : " + JSON.stringify(data.errors));
  }

  const minRank = PRIORITY_RANK[cfg.minPriority] || 4;
  return (data.data.todos || []).filter(
    (t) => (PRIORITY_RANK[t.priority] || 4) <= minRank
  );
}

/** Convertit le titre HTML d'un rappel Jarvi en texte propre. */
function cleanTitle(htmlTitle) {
  if (!htmlTitle) return "Rappel Jarvi";
  let text = htmlTitle
    .replace(/<\/(p|div|li)>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  return text || "Rappel Jarvi";
}

function mentionLabel(todo) {
  const m = (todo.mentions || [])[0];
  if (!m) return null;
  if (m.profile) {
    return [m.profile.firstName, m.profile.lastName].filter(Boolean).join(" ");
  }
  if (m.company) return m.company.name;
  if (m.project) return m.project.name;
  return null;
}

/* ------------------------------------------------------------------ */
/* Construction de l'événement                                         */
/* ------------------------------------------------------------------ */

function buildEvent(todo, cfg) {
  const start = new Date(todo.scheduledAt);
  const end = new Date(start.getTime() + cfg.durationMinutes * 60 * 1000);

  const label = mentionLabel(todo);
  let summary = cfg.titlePrefix + cleanTitle(todo.title);
  if (label && !summary.includes(label)) {
    summary += " (" + label + ")";
  }

  return {
    summary,
    description:
      "Rappel synchronisé depuis Jarvi.\nPriorité : " +
      todo.priority +
      "\nID Jarvi : " +
      todo.id,
    start: { dateTime: start.toISOString(), timeZone: cfg.timezone },
    end: { dateTime: end.toISOString(), timeZone: cfg.timezone },
    extendedProperties: {
      private: {
        jarviTodoId: todo.id,
        jarviPriority: todo.priority,
        jarviScheduledAt: todo.scheduledAt,
      },
    },
    reminders: { useDefault: true },
  };
}

/** Compare l'événement existant à la version désirée. */
function eventNeedsUpdate(existing, desired) {
  if (existing.summary !== desired.summary) return true;
  const exStart = existing.start && existing.start.dateTime;
  const wantStart = desired.start.dateTime;
  if (!exStart || new Date(exStart).getTime() !== new Date(wantStart).getTime()) {
    return true;
  }
  const exPrio =
    existing.extendedProperties &&
    existing.extendedProperties.private &&
    existing.extendedProperties.private.jarviPriority;
  if (exPrio !== desired.extendedProperties.private.jarviPriority) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* Google Calendar                                                     */
/* ------------------------------------------------------------------ */

async function getGoogleAccessToken(env) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error("Google OAuth HTTP " + res.status + " : " + (await res.text()));
  }
  const data = await res.json();
  if (!data.access_token) {
    throw new Error("Pas d'access_token Google : " + JSON.stringify(data));
  }
  return data.access_token;
}

const CAL_BASE = "https://www.googleapis.com/calendar/v3/calendars";

async function findEventByTodoId(accessToken, calendarId, todoId) {
  const url = new URL(
    CAL_BASE + "/" + encodeURIComponent(calendarId) + "/events"
  );
  url.searchParams.set("privateExtendedProperty", "jarviTodoId=" + todoId);
  url.searchParams.set("showDeleted", "false");
  url.searchParams.set("maxResults", "5");

  const res = await fetch(url, {
    headers: { Authorization: "Bearer " + accessToken },
  });
  if (!res.ok) {
    throw new Error("Calendar list HTTP " + res.status + " : " + (await res.text()));
  }
  const data = await res.json();
  return (data.items || [])[0] || null;
}

async function createEvent(accessToken, calendarId, event) {
  const url =
    CAL_BASE + "/" + encodeURIComponent(calendarId) + "/events";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(event),
  });
  if (!res.ok) {
    throw new Error("Calendar insert HTTP " + res.status + " : " + (await res.text()));
  }
  return res.json();
}

async function patchEvent(accessToken, calendarId, eventId, event) {
  const url =
    CAL_BASE +
    "/" +
    encodeURIComponent(calendarId) +
    "/events/" +
    encodeURIComponent(eventId);
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: "Bearer " + accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(event),
  });
  if (!res.ok) {
    throw new Error("Calendar patch HTTP " + res.status + " : " + (await res.text()));
  }
  return res.json();
}

/* ------------------------------------------------------------------ */

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
