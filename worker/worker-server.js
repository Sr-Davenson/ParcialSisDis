const axios = require("axios");
const express = require("express");
const path = require("path");

const app = express();
app.use(express.json());

// Servir SOLO los archivos que la interfaz necesita (no toda la carpeta,
// para no exponer coordinador-server.js ni el resto del proyecto por accidente)
app.get("/worker-app.js", (req, res) => res.sendFile(path.join(__dirname, "worker-app.js")));
app.get("/worker-styles.css", (req, res) => res.sendFile(path.join(__dirname, "worker-styles.css")));

const PORT = process.argv[2] || 3000;
let NAME = process.argv[3] || "Hijo1";

// Si el Middleware nos lanza como proceso hijo (create-server), nos pasa su propia
// URL como 4to argumento y nos autoregistramos solos, sin pasar por el formulario.
const AUTO_MIDDLEWARE_URL = process.argv[4] || "";

let MIDLEWARE_URL = "";
let SELF_URL = `http://localhost:${PORT}`;

let messages = [];
let pulseInterval = null;

// Para la tarjeta "Conexión actual" de la interfaz
let lastPulseOkAt = null;     // timestamp del último pulso aceptado
let lastPulseError = null;    // mensaje del último pulso fallido (null si el último salió bien)
let parentHistory = [];       // últimos cambios de padre: { time, from, to }

// Otros administradores que conocemos (nos los va pasando /register y
// /pulse en sus respuestas). Sirven como candidatos para preguntar "¿quién
// es el líder ahora?" si el administrador actual se cae, usando el mismo
// /election/state que el panel de elección ya usa: no es un endpoint nuevo.
let knownAdmins = [];
const MAX_REDIRECTS = 5;

// ---- TIEMPOS DEL SISTEMA ----
const PULSE_RETRIES = 3;     // pulsos fallidos seguidos antes de buscar otro líder
const PULSE_INTERVAL = 3000; // cada cuánto pulsamos
const PULSE_TIMEOUT = 8000;  // espera máxima de UN pulso
const TASK_LAG_MS = 2000;    // lag simulado: lo que "tarda" el worker en cada tarea

// ==========================================
// PULSOS (HEARTBEAT)
// ==========================================

function stopPulse() {
    if (!pulseInterval) return;

    clearInterval(pulseInterval);
    pulseInterval = null;
    console.log("Dejó de enviar pulsos");
}

function startPulse() {
    stopPulse();

    let fails = 0;
    let inFlight = false; // con timeout (8s) > intervalo (3s) no solapamos pulsos

    pulseInterval = setInterval(async () => {
        if (inFlight) return;
        inFlight = true;

        try {
            const { data } = await axios.post(`${MIDLEWARE_URL}/pulse/${NAME}`, {}, { timeout: PULSE_TIMEOUT });
            fails = 0;
            lastPulseOkAt = Date.now();
            lastPulseError = null;
            console.log(`[${NAME}] Pulso enviado a ${MIDLEWARE_URL}`);

            // El administrador sigue vivo, pero dejó de ser el líder (por
            // ejemplo, revivió/entró alguien con ID más cercano a la Z):
            // nos vamos solos al líder vigente, sin esperar a que se caiga.
            if (data && data.redirect && data.leaderUrl && data.leaderUrl !== MIDLEWARE_URL) {
                console.log(`[${NAME}] ${MIDLEWARE_URL} ya no es el líder, cambiando a ${data.leaderUrl}`);
                try {
                    await registerWithMiddleware(data.leaderUrl, SELF_URL);
                } catch (error) {
                    console.log("No se pudo mudar al nuevo líder: " + error.message);
                }
            }
        } catch (error) {
            fails++;
            lastPulseError = error.message;
            console.log(`Fallo al enviar pulso (${fails}/${PULSE_RETRIES}): ` + error.message);

            // Tras PULSE_RETRIES fallas seguidas asumimos que el administrador
            // actual se cayó de verdad: preguntamos a los demás admins que
            // conocemos quién es el líder ahora y nos mudamos solos.
            if (fails >= PULSE_RETRIES) {
                fails = 0;
                const newLeaderUrl = await findCurrentLeader();
                if (newLeaderUrl && newLeaderUrl !== MIDLEWARE_URL) {
                    console.log(`[${NAME}] ${MIDLEWARE_URL} no responde, cambiando al líder vigente ${newLeaderUrl}`);
                    try {
                        await registerWithMiddleware(newLeaderUrl, SELF_URL);
                    } catch (err) {
                        console.log("No se pudo reconectar al nuevo líder: " + err.message);
                    }
                }
            }
        } finally {
            inFlight = false;
        }
    }, PULSE_INTERVAL);
}

// Le pregunta a cualquier administrador que conozcamos quién es el líder
// vigente, usando /election/state (ya existía para el panel de elección,
// no es un endpoint nuevo). Se usa cuando el administrador actual deja de
// responder del todo, para saber a quién mudarnos.
async function findCurrentLeader() {
    for (const admin of knownAdmins) {
        if (!admin || !admin.url) continue;
        try {
            const { data } = await axios.get(`${admin.url}/election/state`, { timeout: 3000 });
            if (data && data.leaderUrl) return data.leaderUrl;
        } catch (error) {
            // ese administrador también está caído o no responde: probamos el siguiente
        }
    }
    return null;
}

// Registra este mini server en un Middleware y arranca sus pulsos.
// La usan tanto /register (manual, desde la interfaz) como el autoregistro al arrancar
// y /parent (cambio de padre en caliente).
//
// Si el administrador al que le pegamos no es el líder actual, nos redirige
// (ver /register en coordinador-server.js) y acá lo seguimos automáticamente hasta
// llegar al líder de turno. Si registramos directo contra el líder, mucho
// mejor: no hay ningún salto de por medio.
async function registerWithMiddleware(parentUrl, selfUrl, hops = 0) {
    const cleanUrl = parentUrl.endsWith("/") ? parentUrl.slice(0, -1) : parentUrl;

    let response;
    try {
        response = await axios.post(`${cleanUrl}/register`, {
            name: NAME,
            url: selfUrl || SELF_URL
        });
    } catch (error) {
        const data = error.response && error.response.data;

        if (Array.isArray(data && data.knownAdmins)) {
            knownAdmins = data.knownAdmins;
        }

        // Este administrador no es el líder: nos manda directo al líder vigente
        if (data && data.redirect && data.leaderUrl && hops < MAX_REDIRECTS) {
            console.log(`[${NAME}] ${cleanUrl} no es el líder, redirigiendo a ${data.leaderUrl}`);
            return registerWithMiddleware(data.leaderUrl, selfUrl, hops + 1);
        }

        // Todavía no hay líder elegido en ese anillo (elección en curso): esperamos y reintentamos
        if (error.response && error.response.status === 503 && hops < MAX_REDIRECTS) {
            console.log(`[${NAME}] ${cleanUrl} todavía no tiene líder, reintentando en 2s...`);
            await new Promise(r => setTimeout(r, 2000));
            return registerWithMiddleware(cleanUrl, selfUrl, hops + 1);
        }

        throw error;
    }

    if (cleanUrl !== MIDLEWARE_URL) {
        parentHistory.push({ time: Date.now(), from: MIDLEWARE_URL || null, to: cleanUrl });
        parentHistory = parentHistory.slice(-5);
    }
    MIDLEWARE_URL = cleanUrl;
    lastPulseError = null;
    if (selfUrl) SELF_URL = selfUrl;
    if (Array.isArray(response.data.knownAdmins)) {
        knownAdmins = response.data.knownAdmins;
    }

    startPulse();
}

// ==========================================
// RUTA PRINCIPAL: carga la interfaz
// ==========================================

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "worker-interfaz.html"));
});

// Info básica de este mini server (nombre y puerto)
app.get("/info", (req, res) => {
    res.json({ name: NAME, port: PORT });
});

// Padre (Middleware) actual, útil para precargar el formulario en la interfaz
app.get("/parent", (req, res) => {
    res.json({ parent: MIDLEWARE_URL });
});

// Foto completa de la conexión: a qué coordinador estamos pegados, quién es
// el líder según él, y cómo van los pulsos. Alimenta la tarjeta "Conexión
// actual" de la interfaz.
app.get("/connection", async (req, res) => {
    const info = {
        name: NAME,
        selfUrl: SELF_URL,
        parent: MIDLEWARE_URL || null,
        pulsing: Boolean(pulseInterval),
        lastPulseOkAt,
        lastPulseError,
        pulseIntervalMs: PULSE_INTERVAL,
        knownAdmins,
        history: parentHistory,
        parentState: null
    };

    if (MIDLEWARE_URL) {
        try {
            const { data } = await axios.get(`${MIDLEWARE_URL}/election/state`, {
                timeout: 3000,
                headers: { "ngrok-skip-browser-warning": "true" }
            });
            info.parentState = {
                reachable: true,
                id: data.id,
                role: data.role,
                leaderId: data.leader,
                leaderUrl: data.leaderUrl,
                paused: data.paused
            };
        } catch (error) {
            info.parentState = { reachable: false, error: error.message };
        }
    }

    res.json(info);
});

// Cambiar de padre "en caliente", sin renombrar el servidor ni pasar por el formulario completo
app.post("/parent", async (req, res) => {
    const { url } = req.body;

    if (!url) return res.status(400).json({ error: "URL requerida" });

    const previous = MIDLEWARE_URL;

    try {
        await registerWithMiddleware(url, SELF_URL);
        res.json({ message: `Ahora registrado en ${MIDLEWARE_URL}`, parent: MIDLEWARE_URL, previous });
    } catch (error) {
        // Nos quedamos con el padre anterior: registerWithMiddleware no llegó a cambiar nada
        console.log("No se pudo cambiar de padre: " + error.message);
        res.status(502).json({ error: `No se pudo contactar con ${url}` });
    }
});

// Endpoint para registrar el servidor en el Middleware (desde la UI)
app.post("/register", async (req, res) => {
    const { serverName, parentUrl, selfUrl } = req.body;

    if (!serverName || !parentUrl) {
        return res.status(400).json({ error: "El nombre y la URL del Middleware son obligatorios." });
    }

    NAME = serverName;

    try {
        await registerWithMiddleware(parentUrl, selfUrl);

        console.log(`Registrado exitosamente como ${NAME} en ${MIDLEWARE_URL}`);
        return res.json({ message: `Registrado exitosamente como '${NAME}' en el Middleware` });
    } catch (error) {
        console.log("Error al registrarse: " + error.message);
        return res.status(500).json({ error: "No se pudo conectar con el Middleware" });
    }
});

// Detener los pulsos al middleware
app.post("/shutdown", (req, res) => {
    stopPulse();
    res.json({ message: `Pulsos detenidos para ${NAME}` });
});

// Reanudar los pulsos al middleware
app.post("/resume", (req, res) => {
    if (!MIDLEWARE_URL) {
        return res.status(400).json({ error: "Primero debes registrar el servidor." });
    }

    if (!pulseInterval) {
        startPulse();
        console.log("Se reanudó el envío de pulsos");
    }

    res.json({ message: `Pulsos reanudados para ${NAME}` });
});

// Recibir mensaje desde la interfaz y reenviarlo al middleware
app.post("/send-message", async (req, res) => {
    const { message } = req.body;

    if (!message) {
        return res.status(400).json({ error: "El mensaje es obligatorio" });
    }

    if (!MIDLEWARE_URL) {
        return res.status(400).json({ error: "Primero debes registrar el servidor en el Middleware" });
    }

    messages.push(message);

    try {
        await axios.post(`${MIDLEWARE_URL}/send-message/${NAME}`, {
            message: message
        });
        console.log("Mensaje enviado al middleware");
        return res.json({ message: "Mensaje enviado correctamente" });
    } catch (error) {
        console.log("Error al enviar mensaje: " + error.message);
        return res.status(500).json({ error: "No se pudo conectar con el middleware" });
    }
});

// Obtener los mensajes guardados localmente
app.get("/messages", (req, res) => {
    res.json({ messages: messages });
});

// ==========================================
// TAREAS
// ==========================================
// Cada handler valida su payload (validate devuelve un texto de error o null)
// y calcula el resultado (run). El nombre del campo de salida es el del enunciado.

const TASKS = {
    math_compute: {
        description: "Calculadora básica de dos operandos",
        payload: { operation: "add | sub | mul | div", a: "number", b: "number" },
        samplePayload: { operation: "add", a: 10, b: 5 },
        result: { result: "number" },
        validate(p) {
            if (!["add", "sub", "mul", "div"].includes(p.operation)) return "operation debe ser add, sub, mul o div";
            if (typeof p.a !== "number" || !Number.isFinite(p.a)) return "a debe ser un número";
            if (typeof p.b !== "number" || !Number.isFinite(p.b)) return "b debe ser un número";
            if (p.operation === "div" && p.b === 0) return "No se puede dividir entre cero";
            return null;
        },
        run(p) {
            const ops = {
                add: (a, b) => a + b,
                sub: (a, b) => a - b,
                mul: (a, b) => a * b,
                div: (a, b) => a / b
            };
            return { result: ops[p.operation](p.a, p.b) };
        }
    },

    search_text: {
        description: "Cuenta cuántas veces aparece 'query' dentro de 'text' (sin solapar, distingue mayúsculas)",
        payload: { text: "string", query: "string (no vacío)" },
        samplePayload: { text: "hola mundo hola", query: "hola" },
        result: { count: "number" },
        validate(p) {
            if (typeof p.text !== "string") return "text debe ser un string";
            if (typeof p.query !== "string" || p.query.length === 0) return "query debe ser un string no vacío";
            return null;
        },
        run(p) {
            return { count: p.text.split(p.query).length - 1 };
        }
    },

    vector_distance: {
        description: "Distancia euclidiana entre dos vectores de 2 dimensiones",
        payload: { a: "[number, number]", b: "[number, number]" },
        samplePayload: { a: [0, 0], b: [3, 4] },
        result: { distance: "number" },
        validate(p) {
            const okVec = v => Array.isArray(v) && v.length === 2 && v.every(n => typeof n === "number" && Number.isFinite(n));
            if (!okVec(p.a)) return "a debe ser un arreglo de 2 números";
            if (!okVec(p.b)) return "b debe ser un arreglo de 2 números";
            return null;
        },
        run(p) {
            return { distance: Math.hypot(p.a[0] - p.b[0], p.a[1] - p.b[1]) };
        }
    },

    text_transform: {
        description: "Transforma texto (mayúsculas, minúsculas o invertir orden)",
        payload: { text: "string", mode: "upper | lower | reverse" },
        samplePayload: { text: "hola mundo distribuido", mode: "upper" },
        result: { result: "string", length: "number" },
        validate(p) {
            if (typeof p.text !== "string" || p.text.trim().length === 0) return "text debe ser un string no vacío";
            if (!["upper", "lower", "reverse"].includes(p.mode)) return "mode debe ser upper, lower o reverse";
            return null;
        },
        run(p) {
            if (p.mode === "upper") return { result: p.text.toUpperCase(), length: p.text.length };
            if (p.mode === "lower") return { result: p.text.toLowerCase(), length: p.text.length };
            if (p.mode === "reverse") return { result: p.text.split("").reverse().join(""), length: p.text.length };
        }
    }
};

let runningTasks = 0;

// Entrega el resultado al líder actual (POST /task/receive en el Coordinator).
// Si el líder no responde, reintentamos y, a partir del 2do intento, le
// preguntamos a los otros administradores quién es el líder vigente.
// Mensaje "task-result" (así le avisamos al coordinador cómo le fue a una tarea):
//   ok:    { type: "task-result", data: { taskId, status: "ok", result: {...} } }
//   error: { type: "task-result", data: { taskId, status: "error", error: "motivo" } }
function buildTaskResult(taskId, outcome) {
    if (outcome.error !== undefined) {
        return { type: "task-result", data: { taskId, status: "error", error: String(outcome.error) } };
    }
    return { type: "task-result", data: { taskId, status: "ok", result: outcome.result } };
}

async function sendTaskResult(message) {
    let target = MIDLEWARE_URL;

    for (let attempt = 1; attempt <= PULSE_RETRIES; attempt++) {
        try {
            await axios.post(`${target}/task/receive`, message, { timeout: PULSE_TIMEOUT });
            console.log(`[${NAME}] task-result de ${message.data.taskId} (${message.data.status}) enviado a ${target}`);
            return true;
        } catch (error) {
            console.log(`[${NAME}] No se pudo entregar ${message.data.taskId} (${attempt}/${PULSE_RETRIES}): ${error.message}`);

            if (attempt < PULSE_RETRIES) {
                const leader = await findCurrentLeader();
                if (leader) target = leader;
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }

    return false;
}

// El Coordinator nos asigna una tarea.
// Body: { taskId?, type, payload }
// Respondemos 202 enseguida (la tarea tarda 2s) y el resultado viaja por
// separado, como mensaje "task-result", a POST /task/receive del líder.
app.post("/task/assign", (req, res) => {
    const { taskId, type, payload } = req.body || {};

    const task = TASKS[type];
    if (!task) {
        return res.status(400).json({
            error: `Tipo de tarea no soportado: '${type}'`,
            supported: Object.keys(TASKS)
        });
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return res.status(400).json({ error: "payload debe ser un objeto" });
    }

    const invalid = task.validate(payload);
    if (invalid) {
        return res.status(400).json({ error: invalid });
    }

    if (!MIDLEWARE_URL) {
        return res.status(409).json({ error: "El worker no está registrado en ningún Coordinator" });
    }

    const id = taskId || `task-${NAME}-${Date.now()}`;
    runningTasks++;
    console.log(`[${NAME}] Tarea ${id} (${type}) aceptada, tardará ${TASK_LAG_MS / 1000}s`);

    setTimeout(async () => {
        let message;

        try {
            message = buildTaskResult(id, { result: task.run(payload) });
        } catch (error) {
            message = buildTaskResult(id, { error: `Ocurrió un error al ejecutar ${type}: ${error.message}` });
        }

        runningTasks--;
        await sendTaskResult(message);
    }, TASK_LAG_MS);

    res.status(202).json({ message: "Tarea aceptada", taskId: id, status: "accepted" });
});

// Qué sabe hacer este worker (y con qué payload)
app.get("/task/capabilities", (req, res) => {
    const types = Object.keys(TASKS);
    const details = Object.entries(TASKS).map(([type, t]) => ({
        type,
        name: type,
        description: t.description,
        payload: t.payload,
        samplePayload: t.samplePayload || null,
        result: t.result
    }));

    res.json({
        worker: NAME,
        name: NAME,
        running: runningTasks,
        lagMs: TASK_LAG_MS,
        capabilities: details,
        tasks: types,
        types: types,
        supported: types,
        details: details
    });
});

app.listen(PORT, async () => {
    console.log(`Server corriendo en http://localhost:${PORT}`);

    if (AUTO_MIDDLEWARE_URL) {
        // Nos lanzó el Middleware (create-server): nos autoregistramos de una vez
        try {
            await registerWithMiddleware(AUTO_MIDDLEWARE_URL, SELF_URL);
            console.log(`Auto-registrado como ${NAME} en ${MIDLEWARE_URL}`);
        } catch (error) {
            console.log("No se pudo autoregistrar con el Middleware: " + error.message);
        }
    } else {
        console.log("Abre la URL en el navegador para registrar el servidor.");
    }
});