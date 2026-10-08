require("dotenv").config()

const express = require("express")
const path = require("path")
const Airtable = require("airtable")
const methodOverride = require("method-override")

const app = express()
const PORT = process.env.PORT || 3000
const BASE_NAME = process.env.AIRTABLE_BASE_NAME || "Tearfund_WPS_Simulation_MVP"

const airtable = new Airtable({
  apiKey: process.env.AIRTABLE_API_KEY
})

const base = airtable.base(process.env.AIRTABLE_BASE_ID)

app.set("view engine", "ejs")
app.set("views", path.join(__dirname, "views"))

app.use(express.urlencoded({ extended: true }))
app.use(express.json())
app.use(methodOverride("_method"))
app.use(express.static(path.join(__dirname, "public")))

/* =========================================================
   ERROR HELPERS
========================================================= */

class AppError extends Error {
  constructor(message, statusCode = 500, details = null) {
    super(message)
    this.name = "AppError"
    this.statusCode = statusCode
    this.details = details
  }
}

function normalizeError(err) {
  if (!err) return new AppError("Unknown error", 500)
  if (err instanceof AppError) return err
  if (err instanceof Error) return new AppError(err.message, err.statusCode || 500, err)
  if (typeof err === "string") return new AppError(err, 500)
  if (typeof err === "object") {
    return new AppError(
      err.message || err.error || err.type || JSON.stringify(err, null, 2),
      err.statusCode || err.status || 500,
      err
    )
  }
  return new AppError(String(err), 500)
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
}

function logError(err, context = "") {
  const e = normalizeError(err)
  console.error(`\n=== ${BASE_NAME} ERROR ===`)
  if (context) console.error("Context:", context)
  console.error("Message:", e.message)
  console.error("Status:", e.statusCode)
  if (e.details) console.error("Details:", e.details)
  console.error("===========================\n")
}

/* =========================================================
   TABLE DISCOVERY
========================================================= */

const TABLE_CANDIDATES = {
  sessions: ["Session", "Sessions"],
  scenarios: ["Scenario", "Scenarios"],
  injects: ["Inject", "Injects"],
  participants: ["Participant", "Participants"],
  decisions: ["Decision", "Decisions"],
  reflections: ["Reflection", "Reflections"],
  rubric: ["Rubric", "Rubrics"]
}

const TABLES = {}

function serializeRecord(record) {
  return {
    airtableId: record.id,
    ...record.fields
  }
}

async function canReadTable(tableName) {
  try {
    await new Promise((resolve, reject) => {
      base(tableName)
        .select({ maxRecords: 1 })
        .firstPage((err) => {
          if (err) reject(err)
          else resolve()
        })
    })
    return true
  } catch {
    return false
  }
}

async function resolveTableNames() {
  console.log(`Resolving Airtable tables in base "${BASE_NAME}"...`)
  for (const [key, candidates] of Object.entries(TABLE_CANDIDATES)) {
    let found = null
    for (const candidate of candidates) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await canReadTable(candidate)
      if (ok) {
        found = candidate
        break
      }
    }
    if (found) {
      TABLES[key] = found
      console.log(`✓ ${key} -> ${found}`)
    } else {
      console.warn(`✗ ${key} not found. Tried: ${candidates.join(", ")}`)
    }
  }
}

function requireTable(key) {
  const tableName = TABLES[key]
  if (!tableName) {
    throw new AppError(`Airtable table mapping missing for "${key}" in ${BASE_NAME}`, 500)
  }
  return tableName
}

/* =========================================================
   AIRTABLE HELPERS
========================================================= */

async function listRecords(tableKey, options = {}) {
  const tableName = requireTable(tableKey)
  try {
    const rows = []
    await base(tableName)
      .select(options)
      .eachPage((records, fetchNextPage) => {
        records.forEach((r) => rows.push(serializeRecord(r)))
        fetchNextPage()
      })
    return rows
  } catch (err) {
    throw normalizeError({
      message: `Failed to list records from ${tableName}`,
      statusCode: 500,
      originalError: err
    })
  }
}

async function findOne(tableKey, filterByFormula) {
  const rows = await listRecords(tableKey, {
    filterByFormula,
    maxRecords: 1
  })
  return rows[0] || null
}

async function findByAirtableId(tableKey, airtableId) {
  const tableName = requireTable(tableKey)
  try {
    const record = await base(tableName).find(airtableId)
    return serializeRecord(record)
  } catch (err) {
    throw normalizeError({
      message: `Failed to find record ${airtableId} in ${tableName}`,
      statusCode: err?.statusCode || 500,
      originalError: err
    })
  }
}

async function createRecord(tableKey, fields) {
  const tableName = requireTable(tableKey)
  try {
    return await base(tableName).create(fields)
  } catch (err) {
    throw normalizeError({
      message: `Failed to create record in ${tableName}`,
      statusCode: 500,
      originalError: err,
      fields
    })
  }
}

async function updateRecord(tableKey, airtableId, fields) {
  const tableName = requireTable(tableKey)
  try {
    return await base(tableName).update(airtableId, fields)
  } catch (err) {
    throw normalizeError({
      message: `Failed to update record ${airtableId} in ${tableName}`,
      statusCode: 500,
      originalError: err,
      fields
    })
  }
}

/* =========================================================
   DOMAIN HELPERS
========================================================= */

function esc(v) {
  return String(v || "").replace(/'/g, "\\'")
}

async function getActiveSession() {
  const rows = await listRecords("sessions", {
    filterByFormula: `OR({Session Status}='Live',{Session Status}='Active',{Session Status}='Open')`,
    maxRecords: 1
  })
  return rows[0] || null
}

async function findSessionByJoinCode(joinCode) {
  return findOne("sessions", `{Join Code}='${esc(joinCode)}'`)
}

async function getSimulationData(session) {
  if (!session) {
    return {
      session: null,
      scenarios: [],
      injects: [],
      participants: [],
      decisions: [],
      reflections: [],
      rubric: [],
      currentScenario: null,
      currentInject: null
    }
  }

  const simulationId = esc(session["Simulation ID"])
  const sessionId = esc(session["ID"])
  const currentScenarioNumber = Number(session["Current Scenario Number"] || 1)
  const currentInjectId = session["Current Inject ID"]

  const [
    scenarios,
    injects,
    participants,
    decisions,
    reflections,
    rubric
  ] = await Promise.all([
    listRecords("scenarios", {
      filterByFormula: `{Simulation ID}='${simulationId}'`,
      sort: [{ field: "Release Order", direction: "asc" }]
    }),
    listRecords("injects", {
      filterByFormula: `{Simulation ID}='${simulationId}'`,
      sort: [{ field: "Order Number", direction: "asc" }]
    }),
    listRecords("participants", {
      filterByFormula: `{Session ID}='${sessionId}'`
    }),
    listRecords("decisions", {
      filterByFormula: `{Session ID}='${sessionId}'`
    }),
    listRecords("reflections", {
      filterByFormula: `{Session ID}='${sessionId}'`
    }),
    listRecords("rubric", {
      filterByFormula: `{Session ID}='${sessionId}'`
    })
  ])

  const currentScenario =
    scenarios.find((s) => Number(s["Scenario Number"]) === currentScenarioNumber) ||
    scenarios[0] ||
    null

  const currentInject =
    injects.find((i) => i["ID"] === currentInjectId) ||
    injects.find((i) => i["Is Current"] === true) ||
    injects.find((i) => i["Status"] === "Released") ||
    null

  return {
    session,
    scenarios,
    injects,
    participants,
    decisions,
    reflections,
    rubric,
    currentScenario,
    currentInject
  }
}

function visibleInjectsForStudent(injects) {
  return injects.filter((i) =>
    ["Released", "Open", "Current"].includes(i["Status"])
  )
}

function draftCardsFromData(data) {
  return [
    {
      title: "Learning Objectives",
      status: "Draft",
      description:
        "Leadership under pressure, integral mission, Light Wheel analysis, localization, accountability, and WPS."
    },
    {
      title: "Role Cards",
      status: `${data.participants.length} participant(s)`,
      description:
        "Tearfund Country Response Lead with public goal, private concern, constraints, and theological tension."
    },
    {
      title: "Injects",
      status: `${data.injects.length} staged`,
      description:
        "Crisis injects driven by Airtable status and release order."
    },
    {
      title: "Decision Points",
      status: `${data.scenarios.length} scenario(s)`,
      description:
        "Scenario-based decision templates for shelter, localization, peacebuilding, and safeguarding."
    },
    {
      title: "Debrief",
      status: data.reflections.length ? "Responses available" : "Pending",
      description:
        "Reflection prompts and facilitator summary workflow."
    },
    {
      title: "Rubric",
      status: data.rubric.length ? "Scoring in progress" : "Ready",
      description:
        "Competency-based scoring across leadership, ethics, localization, and safeguarding."
    }
  ]
}

function aiSuggestionFor(data) {
  if (!data.currentScenario) {
    return "No active scenario selected. Set the current scenario number in Airtable."
  }

  if (!data.currentInject) {
    return "No inject is currently released. Consider releasing the next crisis inject after role immersion."
  }

  return `Current focus: ${data.currentScenario.Title}. Ask: Who is being protected, who is being exposed to risk, and how are affected communities shaping the decision?`
}

function getHomepageCards(data) {
  return [
    {
      title: "South Sudan",
      subtitle: "Gender-Based Violence & Floods"
    },
    {
      title: "Your Role",
      subtitle: "Tearfund Country Response Lead"
    },
    {
      title: "Your Progress",
      subtitle: `${data.decisions.length} decision(s) submitted`
    }
  ]
}

/* =========================================================
   ROUTES
========================================================= */

app.get("/", asyncHandler(async (req, res) => {
  const session = await getActiveSession()
  const data = await getSimulationData(session)

  res.render("home", {
    title: "Humanitarian Leadership Simulation",
    session,
    data,
    hero: {
      kicker: "Humanitarian Response Coordinator",
      headlineLine1: "LEAD with faith",
      headlineLine2: "UNDER PRESSURE",
      body:
        "Step into a humanitarian leadership role in South Sudan. Navigate crisis leadership, prioritizing complex ethical choices, coordinating between agencies, and accountability to affected populations by making timely decisions with unexpected developments along the way."
    },
    cards: getHomepageCards(data)
  })
}))

app.get("/facilitator", asyncHandler(async (req, res) => {
  const session = await getActiveSession()
  const data = await getSimulationData(session)

  res.render("facilitator", {
    title: "Facilitator Dashboard",
    data,
    draftCards: draftCardsFromData(data),
    aiSuggestion: aiSuggestionFor(data)
  })
}))

app.post("/facilitator/session/update", asyncHandler(async (req, res) => {
  const session = await getActiveSession()
  if (!session) throw new AppError("No active session found", 404)

  const updates = {}
  if (req.body.sessionStatus) updates["Session Status"] = req.body.sessionStatus
  if (req.body.currentScenarioNumber) {
    updates["Current Scenario Number"] = Number(req.body.currentScenarioNumber)
  }
  if (req.body.currentInjectId) updates["Current Inject ID"] = req.body.currentInjectId

  if (!Object.keys(updates).length) {
    throw new AppError("No valid session updates provided", 400)
  }

  await updateRecord("sessions", session.airtableId, updates)
  res.redirect("/facilitator")
}))

app.post("/facilitator/injects/:airtableId/release", asyncHandler(async (req, res) => {
  const session = await getActiveSession()
  if (!session) throw new AppError("No active session available", 404)

  await updateRecord("injects", req.params.airtableId, {
    Status: "Released",
    "Is Current": true
  })

  const inject = await findByAirtableId("injects", req.params.airtableId)

  await updateRecord("sessions", session.airtableId, {
    "Current Inject ID": inject["ID"]
  })

  res.redirect("/facilitator")
}))

app.post("/facilitator/injects/:airtableId/close", asyncHandler(async (req, res) => {
  await updateRecord("injects", req.params.airtableId, {
    Status: "Closed",
    "Is Current": false
  })
  res.redirect("/facilitator")
}))

app.get("/join", (req, res) => {
  res.render("join", {
    title: "Join Simulation",
    error: null
  })
})

app.post("/join", asyncHandler(async (req, res) => {
  const { name, email, joinCode, teamName } = req.body

  if (!name || !email || !joinCode) {
    throw new AppError("Name, email, and join code are required", 400)
  }

  const session = await findSessionByJoinCode(joinCode)

  if (!session) {
    return res.status(404).render("join", {
      title: "Join Simulation",
      error: "Join code not found. Please check the code and try again."
    })
  }

  if (!["Live", "Active", "Open"].includes(session["Session Status"])) {
    return res.status(400).render("join", {
      title: "Join Simulation",
      error: "This session is not currently open."
    })
  }

  const created = await createRecord("participants", {
    ID: `P-${Date.now()}`,
    "Session ID": session["ID"],
    Name: name,
    Email: email,
    Role: "Tearfund Country Response Lead",
    "Team Name": teamName || "",
    "Join Code Entered": joinCode,
    Status: "Joined",
    "Join Time": new Date().toISOString()
  })

  res.redirect(`/student/${created.id}`)
}))

app.get("/student/:participantAirtableId", asyncHandler(async (req, res) => {
  const participant = await findByAirtableId("participants", req.params.participantAirtableId)

  const session = await findOne("sessions", `{ID}='${esc(participant["Session ID"])}'`)
  if (!session) throw new AppError("Session not found for participant", 404)

  const data = await getSimulationData(session)
  const releasedInjects = visibleInjectsForStudent(data.injects)

  const participantDecisions = data.decisions.filter(
    (d) => d["Participant ID"] === participant["ID"]
  )

  const completedScenarioIds = participantDecisions.map((d) => d["Scenario ID"])

  res.render("student", {
    title: "Student Dashboard",
    participant,
    data,
    releasedInjects,
    completedScenarioIds
  })
}))

app.post("/student/:participantAirtableId/decision", asyncHandler(async (req, res) => {
  const participant = await findByAirtableId("participants", req.params.participantAirtableId)

  const {
    sessionId,
    scenarioId,
    injectId,
    immediateDecision,
    rationale,
    theology,
    lightWheel,
    localization,
    aap,
    riskA,
    mitigationA,
    riskB,
    mitigationB
  } = req.body

  if (!sessionId || !scenarioId || !immediateDecision || !rationale) {
    throw new AppError(
      "sessionId, scenarioId, immediateDecision, and rationale are required",
      400
    )
  }

  await createRecord("decisions", {
    ID: `D-${Date.now()}`,
    "Session ID": sessionId,
    "Participant ID": participant["ID"],
    "Scenario ID": scenarioId,
    "Inject ID": injectId || "",
    "Immediate Decision": immediateDecision,
    "Rationale and Tradeoffs": rationale,
    "Theology of Mission Reflection": theology || "",
    "Light Wheel Analysis": lightWheel || "",
    "Localization and Power Shift": localization || "",
    "AAP Reflection": aap || "",
    "Risk A": riskA || "",
    "Mitigation A": mitigationA || "",
    "Risk B": riskB || "",
    "Mitigation B": mitigationB || "",
    "Submitted At": new Date().toISOString()
  })

  await updateRecord("participants", req.params.participantAirtableId, {
    Status: "Decision Submitted"
  })

  res.redirect(`/student/${req.params.participantAirtableId}`)
}))

app.post("/student/:participantAirtableId/reflection", asyncHandler(async (req, res) => {
  const participant = await findByAirtableId("participants", req.params.participantAirtableId)

  const { sessionId, prompt, response } = req.body
  if (!sessionId || !prompt || !response) {
    throw new AppError("sessionId, prompt, and response are required", 400)
  }

  await createRecord("reflections", {
    ID: `R-${Date.now()}`,
    "Session ID": sessionId,
    "Participant ID": participant["ID"],
    "Reflection Prompt": prompt,
    "Reflection Response": response,
    "Submitted At": new Date().toISOString()
  })

  res.redirect(`/student/${req.params.participantAirtableId}`)
}))

app.get("/api/airtable/health", asyncHandler(async (req, res) => {
  const session = await getActiveSession()
  res.json({
    ok: true,
    baseName: BASE_NAME,
    baseId: process.env.AIRTABLE_BASE_ID,
    resolvedTables: TABLES,
    activeSessionFound: !!session,
    activeSessionId: session?.ID || null
  })
}))

app.use((req, res, next) => {
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404))
})

app.use((err, req, res, next) => {
  const e = normalizeError(err)
  logError(e, `${req.method} ${req.originalUrl}`)

  if (req.accepts("json") && !req.accepts("html")) {
    return res.status(e.statusCode || 500).json({
      success: false,
      error: e.message,
      details: process.env.NODE_ENV === "development" ? e.details : undefined
    })
  }

  return res.status(e.statusCode || 500).send(`
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Error</title>
        <style>
          body { font-family: Arial, sans-serif; background: #f1f5f9; padding: 40px; }
          .card { max-width: 720px; margin: 0 auto; background: white; border-radius: 16px; padding: 24px; box-shadow: 0 10px 30px rgba(0,0,0,.08); }
          h1 { margin-top: 0; }
          pre { background: #f8fafc; padding: 12px; border-radius: 10px; overflow: auto; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Application Error</h1>
          <p>${e.message}</p>
          <a href="/">Return home</a>
        </div>
      </body>
    </html>
  `)
})

process.on("unhandledRejection", (reason) => {
  const e = normalizeError(reason)
  console.error("UNHANDLED REJECTION:", e.message, e.details || "")
})

process.on("uncaughtException", (err) => {
  const e = normalizeError(err)
  console.error("UNCAUGHT EXCEPTION:", e.message, e.details || "")
  process.exit(1)
})

async function start() {
  await resolveTableNames()
  app.listen(PORT, () => {
    console.log(`${BASE_NAME} app running at http://localhost:${PORT}`)
  })
}

start().catch((err) => {
  logError(err, "startup")
  process.exit(1)
})