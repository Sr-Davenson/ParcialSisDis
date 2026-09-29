require("dotenv").config();

function normalizeUrl(url) {
    if (!url) return ""
    let clean = String(url).trim()
    while (clean.endsWith("/")) clean = clean.slice(0, -1)
    return clean
}

// Todos los IDs que entran por red pasan por acá antes de guardarse
function normalizeId(id) {
    if (id === null || id === undefined) return null
    const clean = String(id).trim().toUpperCase()
    return clean || null
}

const express = require("express")
const axios = require("axios")
const path = require("path")

const app = express()
app.use(express.json())

// Permite utilizar los archivos de la carpeta public
app.use(express.static(path.join(__dirname, "public")))

// Panel de control de este nodo (interfaz.html + app.js + styles.css).
// Necesita que esos 3 archivos estén dentro de la carpeta "public".
app.get("/panel", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "interfaz.html"))
})

// Alias: cualquier HTML que ya enlace "/styles.css" (por ejemplo tu interfaz.html
// del /panel) sigue funcionando después de renombrar el CSS.
app.get("/styles.css", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "coordinador-styles.css"))
})

// Puerto: argumento CLI > variable de entorno > 3000
const PORT = Number(process.argv[2]) || Number(process.env.PORT) || 3000

// ==========================================
// ELECCIÓN - IDENTIDAD Y ESTADO DEL NODO
// ==========================================
// Uso manual (tipo worker):
//   node index.js {PUERTO} {URL_NGROK} [PEERS]
//   Ej: node index.js 3000 https://chatting-sustained-punctured.ngrok-free.dev
//
// Uso completo tradicional:
//   node index.js {PUERTO} {NODE_ID} {URL_PROPIA} [PEERS]
//   Ej: node index.js 3000 A http://localhost:3000
const arg3 = process.argv[3] || ""
const arg3IsUrl = /^https?:\/\//i.test(arg3)

let NODE_ID = ""
let SELF_URL = ""
let SEEDS_CLI = ""

if (arg3IsUrl) {
    // Si el 3er argumento es una URL (mismo formato que el worker: node index.js 3000 URL)
    SELF_URL = normalizeUrl(arg3)
    NODE_ID = normalizeId(process.env.NODE_ID || `COORDINATOR-${PORT}`)
    SEEDS_CLI = process.argv[4] || ""
} else if (arg3) {
    // Si el 3er argumento es el ID (formato tradicional: node index.js 3000 A URL)
    NODE_ID = normalizeId(arg3)
    SELF_URL = normalizeUrl(process.argv[4] || process.env.PUBLIC_URL || process.env.SELF_URL || `http://localhost:${PORT}`)
    SEEDS_CLI = process.argv[5] || ""
} else {
    // Sin argumentos adicionales: leer de .env o fallback local
    NODE_ID = normalizeId(process.env.NODE_ID || `COORDINATOR-${PORT}`)
    SELF_URL = normalizeUrl(process.env.PUBLIC_URL || process.env.SELF_URL || `http://localhost:${PORT}`)
    SEEDS_CLI = ""
}

const PUBLIC_URL = SELF_URL

// ==========================================
// ALMACENAMIENTO EN MEMORIA
// ==========================================

let servers = {}
let serverProcess = {}
let nextPort = 4000

// Mensajes recibidos
let messages = []

// Logs de actividad
let logs = []

// ---- TIEMPOS DEL SISTEMA ----
const PING_RETRIES = 3       // pings fallidos seguidos antes de dar a un peer por caído
const PING_INTERVAL = 2000   // cada cuánto saludamos a los peers
const PING_TIMEOUT = 5000    // espera máxima de UN ping

const PULSE_RETRIES = 3      // pulsos fallidos seguidos (lo aplica el worker, ver worker-server.js)
const PULSE_INTERVAL = 3000  // cada cuánto pulsa un worker (lo aplica el worker)
const PULSE_TIMEOUT = 8000   // sin pulso durante este tiempo -> el worker pasa a offline

let role = "follower"        // leader | follower
let leaderId = null
let leaderUrl = null

// ==========================================
// MATAR / RECONECTAR ESTE NODO (manual, desde el panel)
// ==========================================
// No apaga Express ni la interfaz: paused=true solo hace que dejemos de
// pulsar a los demás y de responder /election/ping, así el resto del
// anillo nos da por caídos con su propio PEER_TIMEOUT (igual que si de
// verdad nos hubiéramos caído) y recalcula el líder solo.
let paused = false

// peers indexados por url normalizada
// { id, url, lastSeen, alive, role }
let peers = {}

// Agrega un peer si no lo conocíamos (así funciona el chisme/gossip)
function addPeer(url, id) {
    const key = normalizeUrl(url)
    if (!key || key === SELF_URL) return null

    const normId = normalizeId(id)

    if (!peers[key]) {
        peers[key] = { id: normId, url: key, lastSeen: 0, alive: false, role: null, fails: 0, pinging: false }
        addLog("INFO", "PEER_DISCOVERED", normId || key, `Nuevo peer conocido: ${key}`)
    } else if (normId && peers[key].id !== normId) {
        peers[key].id = normId
    }

    return peers[key]
}

function markAlive(peer, extra) {
    if (!peer) return
    peer.lastSeen = Date.now()
    peer.fails = 0
    if (extra && extra.id) peer.id = normalizeId(extra.id)
    if (extra && extra.role) peer.role = extra.role
    if (!peer.alive) {
        peer.alive = true
        addLog("INFO", "PEER_UP", peer.id || peer.url, "El peer respondió y está vivo")
    }
}

// La "foto" de este nodo: lo mismo que devuelve /election/ping y /election/state
function buildState() {
    return {
        id: NODE_ID,
        url: SELF_URL,
        role: role,
        leader: leaderId,
        leaderUrl: leaderUrl,
        paused: paused,
        peers: Object.values(peers).map(p => ({
            id: p.id,
            url: p.url,
            alive: p.alive
        }))
    }
}

// Lista de urls que compartimos en cada ping (incluye la propia)
function knownUrls() {
    return [SELF_URL, ...Object.keys(peers)]
}

// Acepta tanto ["http://..."] como [{ id, url }]
function mergePeerList(list) {
    if (!Array.isArray(list)) return
    list.forEach(item => {
        if (typeof item === "string") addPeer(item, null)
        else if (item && item.url) addPeer(item.url, item.id)
    })
}


// ==========================================
// ALGORITMO DE BULLY (SIN ENDPOINTS NUEVOS)
// ==========================================
// Regla pedida: gana el ID vivo "más cercano a la Z" (mayor en orden
// alfabético). Esto se calcula 100% en local con datos que YA teníamos
// (peer.alive y peer.id, que vienen de /election/ping y /election/peers,
// los mismos endpoints que ya existían antes). No se agrega ningún
// endpoint ni mensaje nuevo: cada nodo simplemente recalcula quién es
// el líder cada vez que cambia su información de peers, y como todos
// comparten (por gossip) el mismo padrón de "quién está vivo", todos
// terminan calculando el mismo ganador sin necesidad de coordinarse
// explícitamente.
function recomputeLeader() {
    if (paused) return

    let bestId = NODE_ID
    let bestUrl = SELF_URL

    Object.values(peers).forEach(peer => {
        if (peer.alive && peer.id && peer.id > bestId) {
            bestId = peer.id
            bestUrl = peer.url
        }
    })

    if (bestId !== leaderId) {
        leaderId = bestId
        leaderUrl = bestUrl
        role = (bestId === NODE_ID) ? "leader" : "follower"
        addLog(
            "INFO",
            "NEW_LEADER",
            bestId,
            bestId === NODE_ID
                ? "Me quedo como líder (Bully): soy el ID vivo más cercano a la Z"
                : `Nuevo líder calculado (Bully): ${bestId} es el ID vivo más cercano a la Z`
        )
    }
}


// ==========================================
// FASE 1 - PING ENTRE NODOS
// ==========================================

app.post("/election/ping", (req, res) => {
    // Si me "mataron" manualmente, no respondo pings: para el resto del
    // anillo esto se ve exactamente igual que si me hubiera caído de verdad.
    if (paused) {
        return res.status(503).json({ error: "Nodo detenido manualmente (kill-server)" })
    }

    const { from, peers: remotePeers } = req.body || {}

    if (!from || !from.url) {
        return res.status(400).json({ error: "Se requiere 'from' con 'id' y 'url'" })
    }

    // 1 y 2. El que llama demuestra que está vivo y dice cómo se llama
    const sender = addPeer(from.url, from.id)
    markAlive(sender, { id: from.id })

    // 3. Intercambio de listas: nos quedamos con los peers que él conoce
    mergePeerList(remotePeers)

    // Recalculamos el líder con la info fresca (por ej. si el que nos
    // pingeó tiene un ID más cercano a la Z que nuestro líder actual)
    recomputeLeader()

    // Respondemos con nuestro propio estado
    res.json(buildState())
})


// ==========================================
// FASE 2 - ESTADO DEL NODO
// ==========================================

app.get("/election/state", (req, res) => {
    res.json(buildState())
})

// Sembrar peers a mano (útil para arrancar el anillo sin reiniciar)
app.post("/election/peers", (req, res) => {
    const { peers: list } = req.body || {}
    if (!Array.isArray(list)) {
        return res.status(400).json({ error: "Se espera { peers: [\"http://...\"] }" })
    }
    mergePeerList(list)
    recomputeLeader()
    res.json({ message: "Peers agregados", peers: buildState().peers })
})


// ==========================================
// PROXIES PARA EL PANEL WEB (evitan CORS)
// ==========================================
// El navegador no puede llamar directo a otro servidor (bloqueo CORS:
// "Failed to fetch"). Estas rutas hacen esas dos mismas llamadas
// (POST /election/peers y GET /election/state) pero server-to-server
// con axios, igual que ya hace pingPeer(). No cambian el algoritmo de
// elección, solo evitan que el navegador tenga que salir cross-origin.

// Cabecera para que ngrok no intercale su página de advertencia
const REMOTE_HEADERS = { "ngrok-skip-browser-warning": "true" }

// Traduce el error de axios a un mensaje útil. Un 404/502/503 que en
// realidad viene de ngrok (túnel apagado, URL vieja) se explica aparte,
// porque si no parece que el error es nuestro cuando es del otro lado.
function explainRemoteError(error) {
    if (error.response) {
        const status = error.response.status
        const body = typeof error.response.data === "string" ? error.response.data : ""
        const looksLikeNgrokDown = /ERR_NGROK|ngrok.com\/docs\/errors|endpoint is offline|tunnel .* not found/i.test(body)

        if (looksLikeNgrokDown || ((status === 404 || status === 502 || status === 503) && /ngrok/i.test(body))) {
            return `El túnel ngrok del otro servidor no responde (¿está apagado o cambió de URL?) — ngrok devolvió ${status}`
        }
        return `El servidor remoto respondió ${status}`
    }
    if (error.code === "ECONNABORTED") return "Tiempo de espera agotado"
    if (error.code === "ENOTFOUND" || error.code === "EAI_AGAIN") return "No se pudo resolver esa URL (¿está bien escrita?)"
    if (error.code === "ECONNREFUSED") return "Conexión rechazada (el servidor no está escuchando ahí)"
    return error.message
}

app.post("/election/register-remote", async (req, res) => {
    const { url } = req.body || {}
    const target = normalizeUrl(url)

    if (!target) {
        return res.status(400).json({ error: "Se requiere 'url'" })
    }

    try {
        const { data } = await axios.post(
            `${target}/election/peers`,
            { peers: [SELF_URL] },
            { timeout: 8000, headers: REMOTE_HEADERS }
        )

        // Lo agregamos también a nuestra propia lista, igual que hacía antes el frontend
        addPeer(target, null)

        res.json({ ok: true, remote: data })
    } catch (error) {
        res.status(502).json({ ok: false, error: explainRemoteError(error) })
    }
})

app.get("/election/ping-peer", async (req, res) => {
    const target = normalizeUrl(req.query.url)

    if (!target) {
        return res.status(400).json({ error: "Se requiere 'url'" })
    }

    const start = Date.now()
    try {
        const { data } = await axios.get(`${target}/election/state`, {
            timeout: 8000,
            headers: REMOTE_HEADERS
        })
        res.json({ ok: true, data, ms: Date.now() - start })
    } catch (error) {
        res.status(502).json({ ok: false, error: explainRemoteError(error) })
    }
})


// ==========================================
// PANEL WEB - PANTALLA DE ELECCIÓN
// ==========================================
// Solo interfaz: reutiliza buildState() y los endpoints
// /election/state y /election/peers que ya existen. No agrega lógica nueva.

app.get("/election", (req, res) => {
    const state = buildState()
    const leaderText = state.leader ? `${state.leader} (${state.leaderUrl})` : "sin líder"

    const peerRows = state.peers.map(p => `
        <tr>
            <td>${p.id || "?"}</td>
            <td>${p.url}</td>
            <td>
                <span class="estado ${p.alive ? "activo" : "caido"}">
                    <span class="dot"></span> ${p.alive ? "activo" : "caído"}
                </span>
            </td>
            <td class="col-ping">
                <button class="btn-ping" onclick="verPing('${p.url}', this)">Ver ping</button>
            </td>
        </tr>
    `).join("") || `
        <tr>
            <td colspan="4" class="empty">Todavía no conozco a ningún otro servidor.</td>
        </tr>
    `

    res.send(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Panel de Elección</title>
            <style>
                :root {
                    --bg: #0b0c14;
                    --card: #171823;
                    --border: #262837;
                    --text: #e6e7ee;
                    --muted: #9296ab;
                    --accent: #7b83ff;
                    --accent-hover: #6a72f5;
                    --green: #34d399;
                    --red: #f5566b;
                }
                * { box-sizing: border-box; }
                body {
                    margin: 0;
                    background: var(--bg);
                    color: var(--text);
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                }
                nav {
                    display: flex;
                    gap: 28px;
                    align-items: center;
                    padding: 16px 32px;
                    border-bottom: 1px solid var(--border);
                    background: #0d0e17;
                }
                nav a {
                    color: var(--muted);
                    text-decoration: none;
                    font-size: 15px;
                    display: flex;
                    align-items: center;
                    gap: 6px;
                }
                nav a:hover { color: var(--text); }
                nav a.active { color: var(--text); }
                .wrap { max-width: 1200px; margin: 0 auto; padding: 28px 32px 60px; }
                .page-title {
                    display: flex;
                    align-items: center;
                    gap: 14px;
                    margin-bottom: 28px;
                }
                .page-title .icon-badge {
                    width: 42px; height: 42px;
                    border-radius: 10px;
                    background: #3a3c4e;
                    display: flex; align-items: center; justify-content: center;
                    font-size: 20px;
                }
                .page-title h1 { margin: 0; font-size: 28px; }
                .grid-top {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 24px;
                    margin-bottom: 24px;
                }
                @media (max-width: 800px) {
                    .grid-top { grid-template-columns: 1fr; }
                }
                .card {
                    background: var(--card);
                    border: 1px solid var(--border);
                    border-radius: 12px;
                    padding: 24px 28px;
                }
                .card h2 {
                    text-align: center;
                    color: var(--accent);
                    font-size: 18px;
                    margin: 0 0 18px;
                }
                .identity-row {
                    display: flex;
                    justify-content: space-between;
                    padding: 6px 0;
                    font-size: 15px;
                }
                .identity-row .label { color: var(--muted); }
                .identity-row .value { font-family: "SF Mono", Consolas, monospace; }
                .identity-note {
                    margin-top: 16px;
                    color: var(--muted);
                    font-size: 13px;
                    text-align: center;
                    line-height: 1.5;
                }
                .register-sub {
                    text-align: center;
                    color: var(--muted);
                    font-size: 13px;
                    margin: -10px 0 18px;
                }
                .register-input {
                    width: 100%;
                    padding: 12px 14px;
                    border-radius: 8px;
                    border: 1px solid var(--border);
                    background: #0f1019;
                    color: var(--text);
                    font-family: "SF Mono", Consolas, monospace;
                    font-size: 14px;
                    margin-bottom: 18px;
                }
                .register-input::placeholder { color: #5b5e70; }
                .register-actions { display: flex; justify-content: center; }
                .btn-primary {
                    background: var(--accent);
                    color: #fff;
                    border: none;
                    padding: 10px 22px;
                    border-radius: 8px;
                    font-size: 14px;
                    font-weight: 600;
                    cursor: pointer;
                }
                .btn-primary:hover { background: var(--accent-hover); }
                .register-status {
                    margin-top: 14px;
                    font-size: 13px;
                    text-align: center;
                    color: var(--muted);
                    word-break: break-word;
                }
                .peers-card table {
                    width: 100%;
                    border-collapse: collapse;
                }
                .peers-card th {
                    text-align: left;
                    color: var(--muted);
                    font-weight: 500;
                    font-size: 14px;
                    padding: 4px 12px 12px;
                    border-bottom: 1px solid var(--border);
                }
                .peers-card td {
                    padding: 14px 12px;
                    border-bottom: 1px solid var(--border);
                    font-size: 14px;
                }
                .peers-card tr:last-child td { border-bottom: none; }
                .col-ping { text-align: right; }
                .estado { display: inline-flex; align-items: center; gap: 8px; }
                .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
                .estado.activo { color: var(--green); }
                .estado.activo .dot { background: var(--green); }
                .estado.caido { color: var(--red); }
                .estado.caido .dot { background: var(--red); }
                .btn-ping {
                    background: #23252f;
                    color: var(--text);
                    border: 1px solid var(--border);
                    padding: 8px 16px;
                    border-radius: 8px;
                    font-size: 13px;
                    cursor: pointer;
                }
                .btn-ping:hover { background: #2c2e3a; }
                .btn-ping:disabled { opacity: .6; cursor: default; }
                .empty { color: var(--muted); text-align: center; padding: 20px !important; }

                /* ==============================
                   MI SERVIDOR: MATAR / RECONECTAR
                ============================== */
                .server-card { text-align: center; }
                .server-controls {
                    display: flex;
                    justify-content: center;
                    gap: 12px;
                    margin: 4px 0 8px;
                }
                .btn-danger, .btn-accent {
                    border: none;
                    padding: 10px 20px;
                    border-radius: 8px;
                    font-size: 13px;
                    font-weight: 700;
                    cursor: pointer;
                }
                .btn-danger { background: var(--red); color: #fff; }
                .btn-danger:hover { background: #dc3a52; }
                .btn-accent { background: var(--green); color: #06281d; }
                .btn-accent:hover { background: #22c393; }
                #server-hint { color: var(--muted); font-size: 13px; margin: 0 0 6px; }

                /* ==============================
                   ESCENARIO: SÍSIFO / GREGORIO SAMSA
                   El bicho camina eternamente empujando su piedra: la sube
                   despacio y, al llegar arriba, se le escapa y vuelve a
                   empezar. Condena eterna, como corresponde.
                ============================== */
                .samsa-stage { position: relative; width: 100%; height: 150px; overflow: hidden; margin-top: 6px; }
                .stage-ground {
                    position: absolute; bottom: 18px; left: 0; right: 0; height: 2px;
                    background: repeating-linear-gradient(90deg, var(--border) 0 10px, transparent 10px 20px);
                }
                .walker {
                    position: absolute; bottom: 18px; left: 0%;
                    display: flex; align-items: flex-end; gap: 2px;
                    animation: sisifo-cycle 16s cubic-bezier(0.65, 0, 0.35, 1) infinite;
                }
                @keyframes sisifo-cycle {
                    0%   { left: 0%; }
                    82%  { left: 68%; }
                    88%  { left: 64%; }
                    100% { left: 0%; }
                }
                .rock {
                    width: 42px; height: 42px; border-radius: 50%; flex-shrink: 0; margin-bottom: 8px;
                    background: radial-gradient(circle at 30% 30%, #94a3b8, #475569 60%, #1e293b);
                    box-shadow: inset -6px -6px 10px rgba(0,0,0,0.5), 0 4px 6px rgba(0,0,0,0.4);
                    animation: rock-roll 1.2s linear infinite;
                }
                @keyframes rock-roll { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

                .roach-zone { height: 100px; width: 120px; display: flex; align-items: center; justify-content: center; position: relative; transform: scale(0.85); }
                .roach { position: relative; width: 110px; height: 100px; animation: float 3s ease-in-out infinite; }
                .hat { position: absolute; width: 80px; height: 22px; background: #111827; border-radius: 5px 5px 2px 2px; top: -5px; left: 15px; z-index: 5; transform: rotate(-5deg); }
                .hat::before { content: ""; position: absolute; width: 105px; height: 10px; background: #020617; border-radius: 50%; bottom: -5px; left: -12px; }
                .hat::after { content: ""; position: absolute; width: 80px; height: 5px; background: #ef4444; bottom: 2px; left: 0; }
                .roach-head { position: absolute; width: 50px; height: 42px; background: #92400e; border-radius: 50%; left: 30px; top: 25px; z-index: 3; border: 3px solid #451a03; }
                .roach-head::before, .roach-head::after { content: ""; position: absolute; width: 8px; height: 8px; background: white; border-radius: 50%; top: 10px; }
                .roach-head::before { left: 10px; }
                .roach-head::after { right: 10px; }
                .eye { position: absolute; width: 3px; height: 3px; background: black; border-radius: 50%; top: 13px; z-index: 5; }
                .eye.one { left: 14px; }
                .eye.two { right: 14px; }
                .roach-body { position: absolute; width: 65px; height: 80px; background: linear-gradient(90deg, #451a03, #a16207, #451a03); border-radius: 45%; left: 22px; top: 45px; z-index: 2; border: 3px solid #271004; }
                .wing { position: absolute; width: 30px; height: 65px; background: #78350f; border: 2px solid #451a03; border-radius: 50%; top: 48px; z-index: 1; }
                .wing.left { left: 0; transform: rotate(25deg); }
                .wing.right { right: 0; transform: rotate(-25deg); }
                .leg { position: absolute; width: 40px; height: 4px; background: #451a03; border-radius: 5px; z-index: 0; }
                .leg.l1 { left: -25px; top: 55px; animation: leg-l1 0.5s ease-in-out infinite; }
                .leg.l2 { left: -27px; top: 75px; animation: leg-l2 0.5s ease-in-out infinite 0.25s; }
                .leg.l3 { left: -22px; top: 92px; animation: leg-l3 0.5s ease-in-out infinite; }
                .leg.r1 { right: -25px; top: 55px; animation: leg-r1 0.5s ease-in-out infinite 0.25s; }
                .leg.r2 { right: -27px; top: 75px; animation: leg-r2 0.5s ease-in-out infinite; }
                .leg.r3 { right: -22px; top: 92px; animation: leg-r3 0.5s ease-in-out infinite 0.25s; }
                @keyframes leg-l1 { 0%, 100% { transform: rotate(25deg); } 50% { transform: rotate(38deg) translateY(-3px); } }
                @keyframes leg-l2 { 0%, 100% { transform: rotate(-5deg); } 50% { transform: rotate(-16deg) translateY(-3px); } }
                @keyframes leg-l3 { 0%, 100% { transform: rotate(-25deg); } 50% { transform: rotate(-38deg) translateY(-3px); } }
                @keyframes leg-r1 { 0%, 100% { transform: rotate(-25deg); } 50% { transform: rotate(-38deg) translateY(-3px); } }
                @keyframes leg-r2 { 0%, 100% { transform: rotate(5deg); } 50% { transform: rotate(16deg) translateY(-3px); } }
                @keyframes leg-r3 { 0%, 100% { transform: rotate(25deg); } 50% { transform: rotate(38deg) translateY(-3px); } }
                .antenna { position: absolute; width: 45px; height: 3px; background: #451a03; top: 27px; z-index: 0; }
                .antenna.left { left: -5px; transform: rotate(-35deg); }
                .antenna.right { right: -5px; transform: rotate(35deg); }
                @keyframes float {
                    0%, 100% { transform: translateY(0) rotate(-2deg); }
                    50% { transform: translateY(-12px) rotate(2deg); }
                }

                /* Corona cuando este nodo es el líder */
                .roach.is-leader .hat { background: linear-gradient(180deg, #fbbf24, #b45309); }
                .roach.is-leader .hat::after { background: #fde68a; }

                /* Nodo detenido manualmente: la escena se congela y apaga color */
                .samsa-stage.stage-paused .walker,
                .samsa-stage.stage-paused .rock,
                .samsa-stage.stage-paused .leg,
                .samsa-stage.stage-paused .roach {
                    animation-play-state: paused;
                }
                .samsa-stage.stage-paused { filter: grayscale(1) brightness(0.7); }
            </style>
        </head>
        <body>
            <nav>
                <a href="/">🏠 Inicio</a>
                <a href="/servers">🖥️ Servidores</a>
                <a href="/monitor">📊 Monitor</a>
                <a href="/logs">📋 Logs</a>
                <a href="/messages">💬 Mensajes</a>
                <a href="/election" class="active">🗳️ Elección</a>
                <a href="/tareas">🧮 Tareas</a>
                    <a href="/panel">🪳 Panel Miniserver</a>
            </nav>

            <div class="wrap">
                <div class="page-title">
                    <div class="icon-badge">🗳️</div>
                    <h1>Panel de Elección</h1>
                </div>

                <div class="grid-top">
                    <div class="card">
                        <h2>Mi identidad</h2>
                        <div class="identity-row"><span class="label">ID</span><span class="value" id="my-id">${state.id}</span></div>
                        <div class="identity-row"><span class="label">URL</span><span class="value" id="my-url">${state.url}</span></div>
                        <div class="identity-row"><span class="label">Role</span><span class="value" id="my-role">${state.role}</span></div>
                        <div class="identity-row"><span class="label">Leader</span><span class="value" id="my-leader">${leaderText}</span></div>
                        <p class="identity-note">
                            El ID y la URL se asignan al arrancar el servidor (variables de entorno NODE_ID / NODE_URL).
                            Si tu ID ya está en uso, el registro de abajo lo va a rechazar.
                        </p>
                    </div>

                    <div class="card">
                        <h2>Registrarme con otro servidor</h2>
                        <p class="register-sub">Pegá la URL pública (ngrok) del otro servidor.</p>
                        <input type="text" id="peer-url" class="register-input" placeholder="https://xxxx.ngrok-free.app">
                        <div class="register-actions">
                            <button class="btn-primary" onclick="registrarme()">Registrarme</button>
                        </div>
                        <div class="register-status" id="register-status"></div>
                    </div>
                </div>

                <div class="card server-card">
                    <h2>Mi servidor</h2>
                    <p id="server-hint">${state.paused ? "💀 Detenido: el resto del anillo te va a dar por caído y va a recalcular el líder." : "🟢 En línea, participando del Bully."}</p>
                    <div class="server-controls">
                        <button id="btn-matar" class="btn-danger" onclick="matarServidor()" style="display:${state.paused ? "none" : "inline-block"}">☠️ Matar Servidor</button>
                        <button id="btn-reconectar-nodo" class="btn-accent" onclick="reconectarServidor()" style="display:${state.paused ? "inline-block" : "none"}">♻️ Reconectar Servidor</button>
                    </div>

                    <div class="samsa-stage ${state.paused ? "stage-paused" : ""}" id="samsa-stage">
                        <div class="stage-ground"></div>
                        <div class="walker" id="walker">
                            <div class="rock"></div>
                            <div class="roach-zone">
                                <div class="roach ${state.role === "leader" ? "is-leader" : ""}" id="roach">
                                    <div class="hat"></div>
                                    <div class="antenna left"></div>
                                    <div class="antenna right"></div>
                                    <div class="leg l1"></div>
                                    <div class="leg l2"></div>
                                    <div class="leg l3"></div>
                                    <div class="leg r1"></div>
                                    <div class="leg r2"></div>
                                    <div class="leg r3"></div>
                                    <div class="wing left"></div>
                                    <div class="wing right"></div>
                                    <div class="roach-body"></div>
                                    <div class="roach-head">
                                        <div class="eye one"></div>
                                        <div class="eye two"></div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="card peers-card">
                    <h2>Servidores que conozco</h2>
                    <table>
                        <thead>
                            <tr>
                                <th>ID</th>
                                <th>URL</th>
                                <th>Estado</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody id="peers-body">
                            ${peerRows}
                        </tbody>
                    </table>
                </div>
            </div>

            <script>
                const SELF_URL = ${JSON.stringify(state.url)};

                // Registra esta URL en el servidor remoto que el usuario pega.
                // Se hace vía el proxy /election/register-remote (nuestro propio
                // backend, con axios) para evitar el bloqueo CORS del navegador.
                async function registrarme() {
                    const input = document.getElementById('peer-url');
                    const statusEl = document.getElementById('register-status');
                    let url = input.value.trim();
                    if (!url) {
                        statusEl.textContent = 'Pegá una URL primero.';
                        return;
                    }
                    url = url.replace(/\\/+$/, '');

                    statusEl.textContent = 'Registrando...';

                    try {
                        const resp = await fetch('/election/register-remote', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ url })
                        });
                        const data = await resp.json();
                        if (!resp.ok || !data.ok) throw new Error(data.error || ('respondió ' + resp.status));

                        statusEl.textContent = '✅ Registrado correctamente con ' + url;
                        input.value = '';
                        cargarEstado();
                    } catch (err) {
                        statusEl.textContent = '❌ No se pudo registrar: ' + err.message;
                    }
                }

                // Pingea a un peer vía el proxy /election/ping-peer (mismo motivo: CORS)
                async function verPing(url, btn) {
                    const original = btn.textContent;
                    btn.disabled = true;
                    btn.textContent = 'Consultando...';
                    try {
                        const resp = await fetch('/election/ping-peer?url=' + encodeURIComponent(url));
                        const result = await resp.json();
                        if (!resp.ok || !result.ok) throw new Error(result.error || ('respondió ' + resp.status));
                        const data = result.data;
                        alert('Ping a ' + url + '\\n' +
                              'ID: ' + data.id + '\\n' +
                              'Role: ' + data.role + '\\n' +
                              'Líder: ' + (data.leader || 'sin líder') + '\\n' +
                              'Tiempo: ' + result.ms + ' ms');
                    } catch (err) {
                        alert('No se pudo contactar a ' + url + '\\n' + err.message);
                    } finally {
                        btn.disabled = false;
                        btn.textContent = original;
                    }
                }

                // Matar / reconectar este nodo (no apaga Express ni esta
                // interfaz: solo pausa la participación en el ping y en Bully)
                async function matarServidor() {
                    try {
                        const resp = await fetch('/shutdown', { method: 'POST' });
                        const data = await resp.json();
                        cargarEstado();
                        alert(data.message);
                    } catch (err) {
                        alert('No se pudo detener el servidor: ' + err.message);
                    }
                }

                async function reconectarServidor() {
                    try {
                        const resp = await fetch('/resume', { method: 'POST' });
                        const data = await resp.json();
                        cargarEstado();
                        alert(data.message);
                    } catch (err) {
                        alert('No se pudo reconectar el servidor: ' + err.message);
                    }
                }

                // Refresca identidad y tabla de peers cada 3s sin recargar la página
                // (así no se pierde lo que estás escribiendo en el input).
                async function cargarEstado() {
                    try {
                        const resp = await fetch('/election/state');
                        const data = await resp.json();

                        document.getElementById('my-id').textContent = data.id;
                        document.getElementById('my-url').textContent = data.url;
                        document.getElementById('my-role').textContent = data.role;
                        document.getElementById('my-leader').textContent =
                            data.leader ? (data.leader + ' (' + data.leaderUrl + ')') : 'sin líder';

                        // Escena de Gregorio Samsa: corona si soy líder, se
                        // congela y pierde color si me maté manualmente
                        const roachEl = document.getElementById('roach');
                        const stageEl = document.getElementById('samsa-stage');
                        if (roachEl) roachEl.classList.toggle('is-leader', data.role === 'leader');
                        if (stageEl) stageEl.classList.toggle('stage-paused', !!data.paused);

                        // Botones matar/reconectar + texto de estado
                        const btnMatar = document.getElementById('btn-matar');
                        const btnReconectarNodo = document.getElementById('btn-reconectar-nodo');
                        const hint = document.getElementById('server-hint');
                        if (btnMatar && btnReconectarNodo) {
                            btnMatar.style.display = data.paused ? 'none' : 'inline-block';
                            btnReconectarNodo.style.display = data.paused ? 'inline-block' : 'none';
                        }
                        if (hint) {
                            hint.textContent = data.paused
                                ? '💀 Detenido: el resto del anillo te va a dar por caído y va a recalcular el líder.'
                                : '🟢 En línea, participando del Bully.';
                        }

                        const body = document.getElementById('peers-body');
                        if (!data.peers || data.peers.length === 0) {
                            body.innerHTML = '<tr><td colspan="4" class="empty">Todavía no conozco a ningún otro servidor.</td></tr>';
                            return;
                        }

                        body.innerHTML = data.peers.map(p => \`
                            <tr>
                                <td>\${p.id || '?'}</td>
                                <td>\${p.url}</td>
                                <td>
                                    <span class="estado \${p.alive ? 'activo' : 'caido'}">
                                        <span class="dot"></span> \${p.alive ? 'activo' : 'caído'}
                                    </span>
                                </td>
                                <td class="col-ping">
                                    <button class="btn-ping" onclick="verPing('\${p.url}', this)">Ver ping</button>
                                </td>
                            </tr>
                        \`).join('');
                    } catch (err) {
                        // si falla, dejamos lo último renderizado
                    }
                }

                setInterval(cargarEstado, 3000);
            </script>
        </body>
        </html>
    `)
})


// ==========================================
// CICLO DE PING (cada PING_INTERVAL) Y DETECCIÓN DE CAÍDOS (PING_RETRIES fallos seguidos)
// ==========================================

async function pingPeer(peer) {
    // Si me detuvieron manualmente, dejo de pulsar a todo el mundo: para
    // el resto del anillo eso se ve idéntico a que me haya caído.
    // `pinging` evita solapar pings: con timeout (5s) > intervalo (2s) un
    // peer lento recibiría varios pings a la vez.
    if (paused || peer.pinging) return
    peer.pinging = true

    try {
        const { data } = await axios.post(
            `${peer.url}/election/ping`,
            { from: { id: NODE_ID, url: SELF_URL }, peers: knownUrls() },
            { timeout: PING_TIMEOUT }
        )

        markAlive(peer, data)

        // Su respuesta también trae peers: los aprendemos
        if (data) mergePeerList(data.peers)
    } catch (error) {
        // Un solo fallo no lo mata: hacen falta PING_RETRIES seguidos.
        peer.fails = (peer.fails || 0) + 1
        if (peer.alive && peer.fails >= PING_RETRIES) {
            markPeerDown(peer)
        }
    } finally {
        peer.pinging = false
    }
}

function markPeerDown(peer) {
    peer.alive = false
    peer.role = null
    addLog("WARNING", "PEER_DOWN", peer.id || peer.url, `Sin respuesta en ${PING_RETRIES} pings seguidos, se da por caído`)

    // Si el que se cayó era el líder, queda vacante (fase 3)
    if (leaderId && peer.id === leaderId) {
        leaderId = null
        leaderUrl = null
        addLog("WARNING", "LEADER_LOST", peer.id, "El líder dejó de responder")
    }
}

setInterval(async () => {
    if (!paused) {
        await Promise.all(Object.values(peers).map(pingPeer))
    }
    recomputeLeader()
}, PING_INTERVAL)


// ==========================================
// MATAR / RECONECTAR MI PROPIO SERVIDOR (BULLY)
// ==========================================
// Pensado para el botón "Detener Pulsos" / "Reconectar Pulsos" del panel.
// No apaga Express ni sirve la interfaz: solo entra/sale del modo "paused",
// así el panel sigue abierto y usable en todo momento.

app.post("/shutdown", (req, res) => {
    if (paused) {
        return res.json({ message: "El nodo ya estaba detenido" })
    }

    const eraLider = role === "leader"
    paused = true
    role = "follower"
    leaderId = null
    leaderUrl = null

    addLog("WARNING", "SELF_KILL", NODE_ID, "Nodo detenido manualmente desde el panel (deja de pulsar y de responder)")

    res.json({
        message: eraLider
            ? "Servidor detenido. Como eras el líder, el resto del anillo va a recalcular con Bully."
            : "Servidor detenido. Dejaste de participar en la elección hasta que te reconectes."
    })
})

app.post("/resume", (req, res) => {
    if (!paused) {
        return res.json({ message: "El nodo ya estaba activo" })
    }

    paused = false
    addLog("INFO", "SELF_REVIVE", NODE_ID, "Nodo reconectado manualmente desde el panel")

    recomputeLeader()

    res.json({ message: "Servidor reconectado. Bully recalculado para decidir el líder." })
})


// ==========================================
// FUNCIÓN PARA CREAR LOGS
// ==========================================

function addLog(level, event, server, detail) {
    const log = {
        time: new Date().toLocaleTimeString(),
        level: level,
        event: event,
        server: server || "-",
        detail: detail
    }
    logs.push(log)
    console.log(`[${log.time}] ${log.level} - ${log.event} - ${log.server} - ${log.detail}`)
}


// ==========================================
// PÁGINA PRINCIPAL
// ==========================================

app.get("/", (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
            <meta charset="UTF-8">
            <meta http-equiv="refresh" content="3"> <!-- Actualización en tiempo real -->
            <title>Servidor Central</title>
            <link rel="stylesheet" href="/coordinador-styles.css">
        </head>
        <body>
            <header>
                <h1>🖥️ Servidor Central</h1>
                <p>Panel de administración y observabilidad</p>
            </header>
            <div class="container">
                <div class="cards">
                    <div class="card">
                        <h2>🖥️ Servidores</h2>
                        <p>Consulta los servidores registrados y su estado.</p>
                        <a class="button" href="/servers">Ver servidores</a>
                    </div>
                    <div class="card">
                        <h2>📊 Monitor</h2>
                        <p>Consulta el estado general del sistema y los Pulse.</p>
                        <a class="button" href="/monitor">Abrir monitor</a>
                    </div>
                    <div class="card">
                        <h2>📋 Logs</h2>
                        <p>Consulta la actividad registrada del servidor.</p>
                        <a class="button" href="/logs">Ver logs</a>
                    </div>
                    <div class="card">
                        <h2>💬 Mensajes</h2>
                        <p>Consulta los mensajes recibidos.</p>
                        <a class="button" href="/messages">Ver mensajes</a>
                    </div>
                    <div class="card">
                        <h2>🧮 Tareas</h2>
                        <p>Asigna tareas a los workers y mira sus resultados.</p>
                        <a class="button" href="/tareas">Asignar tareas</a>
                    </div>
                    <div class="card">
                        <h2>🗳️ Elección</h2>
                        <p>Consulta tu identidad, el líder y registra otros servidores.</p>
                        <a class="button" href="/election">Abrir panel de elección</a>
                    </div>
                </div>
                <div class="status">
                    <h2>📡 Estado del servidor central</h2>
                    <p>🟢 Servidor funcionando correctamente</p>
                    <p>Puerto: ${PORT}</p>
                </div>
            </div>
        </body>
        </html>
    `)
})


// ==========================================
// REGISTRAR MINI-SERVER
// ==========================================

app.post("/register", (req, res) => {
    const { name, url } = req.body

    if (!name || !url) {
        addLog("ERROR", "REGISTER", name, "El nombre y la URL son obligatorios")
        return res.status(400).json({ error: "El nombre y la URL son obligatorios" })
    }

    const serverName = name.trim().toLowerCase()

    if (!serverName) {
        return res.status(400).json({ error: "El nombre del servidor no puede estar vacío" })
    }

    const nameRegex = /^[a-z0-9_-]+$/
    if (!nameRegex.test(serverName)) {
        addLog("WARNING", "REGISTER", serverName, "Nombre rechazado por formato inválido")
        return res.status(400).json({ error: "El nombre solo puede contener letras, números, - y _" })
    }

    // Solo el líder acepta hijos. Si no lo soy, no me registro yo: le aviso
    // al hijo quién es el líder de turno (mismos datos que ya expone
    // /election/state) para que se conecte directo a él, sin inventar
    // ningún endpoint nuevo.
    if (role !== "leader") {
        const knownAdmins = [
            { id: NODE_ID, url: SELF_URL },
            ...Object.values(peers).filter(p => p.id).map(p => ({ id: p.id, url: p.url }))
        ]

        if (!leaderId) {
            addLog("WARNING", "REGISTER_REDIRECT", serverName, "Todavía no hay líder elegido, le pido al hijo que reintente")
            return res.status(503).json({
                error: "Todavía no hay un líder elegido en este anillo, reintentá en unos segundos",
                knownAdmins
            })
        }

        addLog("INFO", "REGISTER_REDIRECT", serverName, `No soy el líder, redirijo a ${leaderId} (${leaderUrl})`)
        return res.status(409).json({
            error: "Este nodo no es el líder actual",
            redirect: true,
            leaderId: leaderId,
            leaderUrl: leaderUrl,
            knownAdmins
        })
    }

    // Antes esto rechazaba SIEMPRE que el nombre ya existiera en `servers`,
    // sin importar si era el mismo worker reconectándose (por ejemplo,
    // volviendo a este nodo tras la caída del líder anterior). Eso es lo
    // que producía "Nombre de servidor duplicado" cuando Z moría y el
    // worker volvía a R, que ya lo tenía registrado de antes.
    //
    // Ahora solo es un duplicado real si hay OTRO worker, con OTRA url,
    // usando el mismo nombre y actualmente online. Si es el mismo worker
    // (misma url) o el registro anterior ya estaba offline/caído,
    // se trata como una reconexión y se actualiza en vez de rechazarse.
    const existing = servers[serverName]
    const isRealDuplicate = existing && existing.status === "online" && existing.url !== url

    if (isRealDuplicate) {
        addLog("WARNING", "REGISTER", serverName, `Nombre de servidor duplicado (ya online desde ${existing.url})`)
        return res.status(409).json({ error: "Ya existe un servidor online con ese nombre" })
    }

    // Registrar (o re-registrar/actualizar) servidor con estado "online"
    servers[serverName] = {
        name: serverName,
        url: url,
        lastHeartbeat: Date.now(),
        status: "online",
        capabilities: existing ? (existing.capabilities || null) : null,
        capabilitiesDetails: existing ? (existing.capabilitiesDetails || []) : [],
        capabilitiesError: null,
        capabilitiesCheckedAt: 0
    }
    refreshCapabilities(serverName)   // en segundo plano: no retrasa la respuesta del registro

    console.log(`Server registered successfully: ${serverName}`)
    addLog("INFO", "REGISTER", serverName, existing ? "Servidor re-registrado (reconexión)" : "Servidor registrado correctamente")

    res.json({
        message: "Server registered successfully",
        server: serverName,
        leaderId: NODE_ID,
        leaderUrl: SELF_URL,
        knownAdmins: [
            { id: NODE_ID, url: SELF_URL },
            ...Object.values(peers).filter(p => p.id).map(p => ({ id: p.id, url: p.url }))
        ]
    })
})


// ==========================================
// KILL SERVER (MANTENIDO MANUALMENTE)
// ==========================================

app.post("/kill-server/:name", (req, res) => {
    const { name } = req.params

    if (!serverProcess[name]) {
        addLog("WARNING", "KILL", name, "No se encontró el proceso del servidor")
        return res.status(400).json({ error: "server not found" })
    }

    console.log(`server ${name} is killed`)
    addLog("INFO", "KILL", name, "Servidor detenido manualmente")

    serverProcess[name].process.kill()
    delete serverProcess[name]
    delete servers[name]

    res.json({ message: `${name} killed` })
})


// ==========================================
// PULSE
// ==========================================

app.post("/pulse/:name", (req, res) => {
    const serverName = req.params.name.trim().toLowerCase()

    if (servers[serverName]) {
        servers[serverName].lastHeartbeat = Date.now()

        // Si estaba offline, regresarlo a online
        if (servers[serverName].status === "offline") {
            servers[serverName].status = "online"
            addLog("INFO", "RECONNECT", serverName, "El servidor ha vuelto a estar en línea")
        }

        console.log(`Pulso recibido de ${serverName}`)

        if (!servers[serverName].capabilitiesBusy && Date.now() - (servers[serverName].capabilitiesCheckedAt || 0) > CAPABILITIES_REFRESH_MS) {
            refreshCapabilities(serverName)
        }

        const payload = {
            message: "Heartbeat recibido",
            server: serverName
        }

        // Dejé de ser el líder (por ejemplo, se conectó/revivió un admin con
        // ID más cercano a la Z) mientras este hijo seguía apuntándome a mí:
        // le aviso para que se mude solo al líder vigente, sin esperar a que
        // yo directamente me caiga.
        if (role !== "leader" && leaderUrl) {
            payload.redirect = true
            payload.leaderId = leaderId
            payload.leaderUrl = leaderUrl
        }

        res.json(payload)
    } else {
        console.log(`Pulso rechazado: servidor ${serverName} no encontrado`)
        res.status(404).json({ error: "Servidor no encontrado" })
    }
})


// ==========================================
// SERVIDORES
// ==========================================

app.get("/servers", (req, res) => {
    const serverList = Object.values(servers)

    res.send(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
            <meta charset="UTF-8">
            <meta http-equiv="refresh" content="3"> <!-- Actualización en tiempo real -->
            <title>Servidores</title>
            <link rel="stylesheet" href="/coordinador-styles.css">
        </head>
        <body>
            <div class="container">
                <nav>
                    <a href="/">🏠 Inicio</a>
                    <a href="/servers">🖥️ Servidores</a>
                    <a href="/monitor">📊 Monitor</a>
                    <a href="/logs">📋 Logs</a>
                    <a href="/messages">💬 Mensajes</a>
                    <a href="/election">🗳️ Elección</a>
                    <a href="/tareas">🧮 Tareas</a>
                    <a href="/panel">🪳 Panel Miniserver</a>
                </nav>

                <h1>🖥️ Servidores registrados</h1>

                <table>
                    <tr>
                        <th>Servidor</th>
                        <th>URL</th>
                        <th>Último Pulse</th>
                        <th>Estado</th>
                    </tr>
                    ${
                        serverList.map(server => {
                            const seconds = Math.floor((Date.now() - server.lastHeartbeat) / 1000)
                            const isOffline = server.status === "offline"
                            
                            return `
                                <tr>
                                    <td>${server.name}</td>
                                    <td>${server.url}</td>
                                    <td>Hace ${seconds} segundos</td>
                                    <td class="${isOffline ? 'offline' : 'active'}">
                                        ${isOffline ? '🔴 OFFLINE' : '🟢 ACTIVO'}
                                    </td>
                                </tr>
                            `
                        }).join("") ||
                        `
                            <tr>
                                <td colspan="4">No hay servidores registrados.</td>
                            </tr>
                        `
                    }
                </table>
            </div>
        </body>
        </html>
    `)
})


// ==========================================
// MONITOR
// ==========================================

app.get("/monitor", (req, res) => {
    const serverList = Object.values(servers)
    const activeServers = serverList.filter(s => s.status === "online").length
    const offlineServers = serverList.filter(s => s.status === "offline").length

    res.send(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
            <meta charset="UTF-8">
            <meta http-equiv="refresh" content="3"> <!-- Actualización en tiempo real -->
            <title>Monitor</title>
            <link rel="stylesheet" href="/coordinador-styles.css">
        </head>
        <body>
            <div class="container">
                <nav>
                    <a href="/">🏠 Inicio</a>
                    <a href="/servers">🖥️ Servidores</a>
                    <a href="/logs">📋 Logs</a>
                    <a href="/messages">💬 Mensajes</a>
                    <a href="/election">🗳️ Elección</a>
                    <a href="/tareas">🧮 Tareas</a>
                    <a href="/panel">🪳 Panel Miniserver</a>
                </nav>

                <h1>📊 Monitor del sistema</h1>

                <div class="cards">
                    <div class="card">
                        <h2>🖥️ Servidores Activos</h2>
                        <div class="number">${activeServers}</div>
                        <p>En línea actualmente (${offlineServers} offline)</p>
                    </div>

                    <div class="card">
                        <h2>📋 Logs</h2>
                        <div class="number">${logs.length}</div>
                        <p>Eventos registrados</p>
                    </div>

                    <div class="card">
                        <h2>💬 Mensajes</h2>
                        <div class="number">${messages.length}</div>
                        <p>Mensajes recibidos</p>
                    </div>
                </div>

                <div class="status">
                    <h2>📡 Estado del sistema</h2>
                    <p>🟢 Servidor central funcionando</p>
                    <p>Puerto: ${PORT}</p>
                </div>

                <div class="status">
                    <h2>🗳️ Anillo de elección</h2>
                    <p>Nodo: <strong>${NODE_ID}</strong> (${SELF_URL})</p>
                    <p>Estado: <strong>${paused ? "💀 detenido manualmente" : "🟢 activo"}</strong></p>
                    <p>Rol: <strong>${role}</strong></p>
                    <p>Líder: ${leaderId ? `${leaderId} → ${leaderUrl}` : "sin líder"}</p>
                    <p>Peers: ${
                        Object.values(peers)
                            .map(p => `${p.alive ? "🟢" : "🔴"} ${p.id || "?"} (${p.url})`)
                            .join(" · ") || "ninguno conocido"
                    }</p>
                </div>
            </div>
        </body>
        </html>
    `)
})


// ==========================================
// RECIBIR MENSAJES
// ==========================================

app.post("/send-message/:name", (req, res) => {
    const { name } = req.params
    const { message } = req.body

    if (!message) {
        addLog("WARNING", "MESSAGE", name, "Se recibió un mensaje vacío")
        return res.status(400).json({ error: "El campo message es obligatorio" })
    }

    messages.push({
        server: name,
        message: message,
        time: new Date().toLocaleTimeString()
    })

    addLog("INFO", "MESSAGE", name, `Mensaje recibido: ${message}`)
    console.log(`Mensaje recibido de ${name}: ${message}`)

    res.json({ status: "mensaje recibido con exito" })
})


// ==========================================
// MOSTRAR MENSAJES
// ==========================================

app.get("/messages", (req, res) => {
    const messageList = messages.map(msg => `
        <div class="message">
            <strong>${msg.server}</strong>
            <p>${msg.message}</p>
            <small>${msg.time}</small>
        </div>
    `).reverse().join("")

    res.send(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
            <meta charset="UTF-8">
            <meta http-equiv="refresh" content="3"> <!-- Actualización en tiempo real -->
            <title>Mensajes recibidos</title>
            <link rel="stylesheet" href="/coordinador-styles.css">
        </head>
        <body>
            <div class="container">
                <nav>
                    <a href="/">🏠 Inicio</a>
                    <a href="/servers">🖥️ Servidores</a>
                    <a href="/monitor">📊 Monitor</a>
                    <a href="/logs">📋 Logs</a>
                    <a href="/election">🗳️ Elección</a>
                    <a href="/tareas">🧮 Tareas</a>
                    <a href="/panel">🪳 Panel Miniserver</a>
                </nav>

                <h1>💬 Mensajes recibidos</h1>
                ${messageList || "<p>No hay mensajes todavía.</p>"}
            </div>
        </body>
        </html>
    `)
})


// ==========================================
// MOSTRAR LOGS
// ==========================================

app.get("/logs", (req, res) => {
    const logList = logs.map(log => `
        <div class="log">
            <span>${log.time}</span>
            <strong>${log.level}</strong>
            <b>${log.event}</b>
            <span>${log.server}</span>
            <p>${log.detail}</p>
        </div>
    `).reverse().join("")

    res.send(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
            <meta charset="UTF-8">
            <meta http-equiv="refresh" content="3"> <!-- Actualización en tiempo real -->
            <title>Logs</title>
            <link rel="stylesheet" href="/coordinador-styles.css">
        </head>
        <body>
            <div class="container">
                <nav>
                    <a href="/">🏠 Inicio</a>
                    <a href="/servers">🖥️ Servidores</a>
                    <a href="/monitor">📊 Monitor</a>
                    <a href="/messages">💬 Mensajes</a>
                    <a href="/election">🗳️ Elección</a>
                    <a href="/tareas">🧮 Tareas</a>
                    <a href="/panel">🪳 Panel Miniserver</a>
                </nav>

                <h1>📋 Logs del sistema</h1>
                ${logList || "<p>No hay actividad registrada.</p>"}
            </div>
        </body>
        </html>
    `)
})


// ==========================================
// DETECCIÓN DE SERVIDORES CAÍDOS
// ==========================================
// Un worker que lleva más de PULSE_TIMEOUT sin pulsar pasa a offline.

setInterval(() => {
    const now = Date.now()

    Object.keys(servers).forEach(name => {
        if (now - servers[name].lastHeartbeat > PULSE_TIMEOUT && servers[name].status !== "offline") {

            console.log(`server ${name} timed out. Cambiando estado a OFFLINE...`)

            addLog("WARNING", "TIMEOUT", name, `El servidor dejó de enviar Pulse por más de ${PULSE_TIMEOUT / 1000}s, se marcó como offline`)

            servers[name].status = "offline"
        }
    })
}, 1000)


// ==========================================
// TAREAS (Coordinator -> Worker -> Coordinator)
// ==========================================
// Flujo:
//   1. El coordinador llama  POST {worker}/task/assign   (endpoint del WORKER)
//   2. El worker responde 202, espera ~2s (lag simulado), calcula
//   3. El worker llama       POST {líder}/task/receive   (endpoint de ESTE archivo)

let tasks = {}   // taskId -> { taskId, worker, type, payload, status, result, error, assignedAt, finishedAt }
let nextTaskId = 1

// ---- CAPACIDADES DE LOS WORKERS ----
// Cada worker dice qué tareas sabe hacer en GET /task/capabilities. Lo
// consultamos al registrarse, con cada pulso si los datos tienen más de
// CAPABILITIES_REFRESH_MS, y a demanda. Se guarda en servers[name].capabilities
// (arreglo de tipos) o null si todavía no lo sabemos.
const KNOWN_TASK_TYPES = ["math_compute", "http_fetch", "search_text", "stats_compute", "vector_distance", "http_latency", "text_transform"]
const CAPABILITIES_REFRESH_MS = 30000

// Acepta varios formatos, porque cada equipo puede responder distinto:
//   Norma estandarizada: { worker: "...", capabilities: ["t1", "t2"], schemas: { "t1": { description, payload, expectedResult } } }
//   Formatos alternativos: ["math_compute", ...] | [{ type }, ...] | { capabilities|tasks|types: [...] }
function parseCapabilities(data) {
    let list = Array.isArray(data) ? data : null

    if (!list && data && typeof data === "object") {
        if (data.schemas && typeof data.schemas === "object" && !Array.isArray(data.schemas)) {
            const keys = Object.keys(data.schemas)
            if (keys.length > 0) return keys
        }
        // Buscar cualquier propiedad que sea un arreglo no vacío
        list = data.capabilities || data.tasks || data.types || data.supported || data.details
    }

    if (!Array.isArray(list)) return null

    const types = list
        .map(item => (typeof item === "string" ? item : item && (item.type || item.name)))
        .filter(t => typeof t === "string" && t.trim())
        .map(t => t.trim())

    return types.length ? [...new Set(types)] : null
}

// Extrae el esquema y detalles de cada tarea anunciada por el worker
function parseCapabilitiesDetails(data) {
    if (!data) return []

    // 1. Norma estandarizada: propiedad 'schemas' como objeto map { "tarea": { description, payload, expectedResult } }
    if (data.schemas && typeof data.schemas === "object" && !Array.isArray(data.schemas)) {
        return Object.entries(data.schemas).map(([type, s]) => {
            if (!s || typeof s !== "object") return null
            return {
                type: type.trim(),
                description: s.description || "",
                payload: s.payload || {},
                samplePayload: s.payload || null,
                result: s.expectedResult || s.result || null
            }
        }).filter(Boolean)
    }

    // 2. Formatos con listas de objetos
    let list = null
    if (Array.isArray(data.details)) {
        list = data.details
    } else if (Array.isArray(data.capabilities) && typeof data.capabilities[0] === "object") {
        list = data.capabilities
    } else if (Array.isArray(data.tasks) && typeof data.tasks[0] === "object") {
        list = data.tasks
    } else if (Array.isArray(data) && typeof data[0] === "object") {
        list = data
    }

    if (!list) return []

    return list.map(item => {
        if (!item || typeof item !== "object") return null
        const type = item.type || item.name
        if (!type || typeof type !== "string") return null
        return {
            type: type.trim(),
            description: item.description || "",
            payload: item.payload || {},
            samplePayload: item.samplePayload || null,
            result: item.result || null
        }
    }).filter(Boolean)
}

async function refreshCapabilities(name) {
    const worker = servers[name]
    if (!worker || worker.capabilitiesBusy) return

    worker.capabilitiesBusy = true

    try {
        const { data } = await axios.get(`${normalizeUrl(worker.url)}/task/capabilities`, {
            timeout: 5000,
            headers: REMOTE_HEADERS
        })

        console.log(`[CAPABILITIES] ${name} respondió:`, JSON.stringify(data).slice(0, 300))

        const types = parseCapabilities(data)
        if (!types) {
            // Formato desconocido: guardamos el error pero no tiramos excepción
            const rawKeys = data && typeof data === "object" ? Object.keys(data).join(", ") : typeof data
            const detail = `Formato desconocido (claves: ${rawKeys}). Se necesita { capabilities|tasks|types: [...] }`
            console.warn(`[CAPABILITIES] ${name}: ${detail}`)
            worker.capabilitiesError = detail
            worker.capabilitiesCheckedAt = Date.now()
            worker.capabilitiesBusy = false
            addLog("WARNING", "CAPABILITIES", name, detail)
            return
        }

        const details = parseCapabilitiesDetails(data)

        if (JSON.stringify(worker.capabilities) !== JSON.stringify(types)) {
            addLog("INFO", "CAPABILITIES", name, `Soporta: ${types.join(", ") || "ninguna tarea"}`)
        }
        worker.capabilities = types
        worker.capabilitiesDetails = details
        worker.capabilitiesError = null
    } catch (error) {
        const detail = explainRemoteError(error)
        if (worker.capabilitiesError !== detail) {
            addLog("WARNING", "CAPABILITIES", name, `No se pudieron consultar sus capacidades: ${detail}`)
        }
        worker.capabilitiesError = detail
    } finally {
        worker.capabilitiesCheckedAt = Date.now()
        worker.capabilitiesBusy = false
    }
}

// Elige un worker online que sepa hacer `type`, el que tenga menos tareas pendientes.
// Si ninguno confirmó soportarla, usa los que aún no reportan capacidades.
function pickWorker(type) {
    const pending = name => Object.values(tasks).filter(t => t.worker === name && t.status === "assigned").length
    const online = Object.values(servers).filter(w => w.status === "online")

    const confirmed = online.filter(w => w.capabilities && w.capabilities.includes(type))
    const pool = confirmed.length ? confirmed : online.filter(w => !w.capabilities)

    if (!pool.length) return null
    return pool.sort((a, b) => pending(a.name) - pending(b.name))[0].name
}

function workersView() {
    return Object.values(servers).map(w => ({
        name: w.name,
        url: w.url,
        status: w.status,
        lastHeartbeat: w.lastHeartbeat,
        capabilities: w.capabilities || null,
        capabilitiesDetails: w.capabilitiesDetails || [],
        capabilitiesError: w.capabilitiesError || null,
        capabilitiesCheckedAt: w.capabilitiesCheckedAt || null
    }))
}

// Envía una tarea a un worker registrado. Devuelve el registro de la tarea.
async function assignTask(workerName, type, payload) {
    const name = String(workerName || "").trim().toLowerCase()
    const worker = servers[name]

    if (!worker) throw Object.assign(new Error("Worker no registrado"), { status: 404 })
    if (worker.status !== "online") throw Object.assign(new Error("El worker está offline"), { status: 409 })

    // ¿Sabe hacer esta tarea? Si todavía no conocemos sus capacidades las pedimos ahora.
    // Si el worker no tiene /task/capabilities (versión vieja), dejamos pasar: él mismo
    // rechazará el tipo que no soporte.
    if (!worker.capabilities && Date.now() - (worker.capabilitiesCheckedAt || 0) > 5000) {
        await refreshCapabilities(name)
    }
    if (worker.capabilities && !worker.capabilities.includes(type)) {
        const soporta = worker.capabilities.join(", ") || "ninguna tarea"
        throw Object.assign(new Error(`El worker '${name}' no soporta '${type}'. Soporta: ${soporta}`), { status: 409 })
    }

    const taskId = `task-${NODE_ID}-${nextTaskId++}`

    tasks[taskId] = {
        taskId,
        worker: name,
        type,
        payload,
        status: "assigned",
        result: null,
        error: null,
        assignedAt: Date.now(),
        finishedAt: null
    }

    const target = `${normalizeUrl(worker.url)}/task/assign`

    try {
        await axios.post(
            target,
            { taskId, type, payload },
            { timeout: PULSE_TIMEOUT, headers: REMOTE_HEADERS }
        )
        addLog("INFO", "TASK_ASSIGNED", name, `${taskId} (${type}) asignada`)
        return tasks[taskId]
    } catch (error) {
        // El worker rechazó la tarea (payload inválido, tipo desconocido...) o no respondió
        const status = error.response && error.response.status
        const workerMsg = error.response && error.response.data && error.response.data.error
        let detail

        if (workerMsg) {
            // El worker contestó y rechazó la tarea (payload inválido, tipo desconocido...)
            detail = workerMsg
        } else if (status === 502 && /ngrok/i.test(String(error.response.data))) {
            detail = `ngrok recibió la petición pero el worker no contestó (502). Revisa que el túnel apunte al puerto del worker y que el worker esté corriendo. URL usada: ${target}`
        } else if (status === 404 && !/ngrok/i.test(String(error.response.data))) {
            detail = `El worker respondió 404: no tiene POST /task/assign (¿versión vieja del worker?). URL usada: ${target}`
        } else {
            detail = `${explainRemoteError(error)}. URL usada: ${target}`
        }

        tasks[taskId].status = "failed"
        tasks[taskId].error = detail
        tasks[taskId].finishedAt = Date.now()

        addLog("ERROR", "TASK_ASSIGN", name, `${taskId} no se pudo asignar: ${detail}`)
        throw Object.assign(new Error(detail), { status: (error.response && error.response.status) || 502 })
    }
}

// El worker nos entrega el resultado cuando termina, como mensaje "task-result":
//   { "type": "task-result", "data": { "taskId": "task-123", "status": "ok",    "result": {} } }
//   { "type": "task-result", "data": { "taskId": "task-123", "status": "error", "error": "motivo" } }
// Se acepta aunque este nodo ya no sea el líder o no conozca el taskId (por
// ejemplo, si el líder cambió mientras la tarea corría): así no se pierde
// un resultado ya calculado.
app.post("/task/receive", (req, res) => {
    const { type, data } = req.body || {}

    if (type !== "task-result" || !data || typeof data !== "object") {
        addLog("WARNING", "TASK_RECEIVE", "-", "Mensaje inválido: se esperaba { type: 'task-result', data: {...} }")
        return res.status(400).json({ error: "Se espera { type: 'task-result', data: { taskId, status, result | error } }" })
    }

    const { taskId, status, result, error } = data

    if (!taskId || typeof taskId !== "string") {
        addLog("WARNING", "TASK_RECEIVE", "-", "task-result sin taskId")
        return res.status(400).json({ error: "data.taskId es obligatorio" })
    }

    if (status !== "ok" && status !== "error") {
        return res.status(400).json({ error: "data.status debe ser 'ok' o 'error'" })
    }

    const ok = status === "ok"
    const previous = tasks[taskId]

    tasks[taskId] = {
        ...(previous || { taskId, worker: "?", type: "?", assignedAt: null, payload: null }),
        // Internamente seguimos usando completed/failed (es lo que pinta la página /tareas)
        status: ok ? "completed" : "failed",
        result: ok ? (result ?? {}) : null,
        error: ok ? null : (error || "Error desconocido"),
        finishedAt: Date.now()
    }

    const t = tasks[taskId]
    addLog(
        ok ? "INFO" : "WARNING",
        "TASK_RESULT",
        t.worker,
        ok
            ? `${taskId} (${t.type}) ok: ${JSON.stringify(t.result)}${previous ? "" : " [tarea no asignada por este nodo]"}`
            : `${taskId} (${t.type}) error: ${t.error}${previous ? "" : " [tarea no asignada por este nodo]"}`
    )

    res.json({ message: "Resultado recibido", taskId })
})

// ---- Auxiliares (opcionales, para poder disparar y ver tareas) ----
// Sin esto assignTask() no tiene quién la llame. Bórralas si tu profe
// solo quiere ver los 3 endpoints de tareas.

// Body: { worker?: "hijo1", type: "math_compute", payload: {...} }
// Si no se manda 'worker', el coordinador elige uno online que soporte esa tarea.
app.post("/task/dispatch", async (req, res) => {
    const { worker, type, payload } = req.body || {}

    if (!type) {
        return res.status(400).json({ error: "Se requiere 'type'" })
    }

    let target = worker
    if (!target) {
        target = pickWorker(type)
        if (!target) {
            return res.status(409).json({ error: `Ningún worker online soporta '${type}'` })
        }
    }

    try {
        const task = await assignTask(target, type, payload)
        res.status(202).json(task)
    } catch (error) {
        res.status(error.status || 500).json({ error: error.message })
    }
})

// Página para asignar tareas (public/coordinador-tareas.html + public/coordinador-tareas.js)
app.get("/tareas", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "coordinador-tareas.html"))
})

// Workers registrados en ESTE coordinador, para llenar el selector de la página
app.get("/task/workers", (req, res) => {
    res.json(workersView())
})

// Catálogo agrupado de capacidades de todos los workers online
app.get("/task/capabilities", (req, res) => {
    const catalog = {}
    Object.values(servers).filter(w => w.status === "online").forEach(w => {
        (w.capabilitiesDetails || []).forEach(d => {
            if (!catalog[d.type]) {
                catalog[d.type] = {
                    type: d.type,
                    description: d.description,
                    payload: d.payload,
                    samplePayload: d.samplePayload || null,
                    result: d.result || null,
                    workers: []
                }
            }
            if (!catalog[d.type].workers.includes(w.name)) {
                catalog[d.type].workers.push(w.name)
            }
        })
    })

    res.json({
        capabilities: Object.keys(catalog),
        details: Object.values(catalog)
    })
})

app.get("/task/catalog", (req, res) => {
    const catalog = {}
    Object.values(servers).filter(w => w.status === "online").forEach(w => {
        (w.capabilitiesDetails || []).forEach(d => {
            if (!catalog[d.type]) {
                catalog[d.type] = {
                    type: d.type,
                    description: d.description,
                    payload: d.payload,
                    samplePayload: d.samplePayload || null,
                    result: d.result || null,
                    workers: []
                }
            }
            if (!catalog[d.type].workers.includes(w.name)) {
                catalog[d.type].workers.push(w.name)
            }
        })
    })
    res.json(catalog)
})

// Vuelve a preguntarle sus capacidades a todos los workers online y devuelve la lista
app.post("/task/workers/refresh", async (req, res) => {
    await Promise.all(Object.keys(servers).filter(n => servers[n].status === "online").map(refreshCapabilities))
    res.json(workersView())
})

app.get("/task/results", (req, res) => {
    res.json(Object.values(tasks).sort((a, b) => (b.assignedAt || 0) - (a.assignedAt || 0)))
})


// ==========================================
// INICIAR SERVIDOR
// ==========================================

app.listen(PORT, () => {
    console.log(`Middleware corriendo en http://localhost:${PORT}`)
    console.log(`Nodo '${NODE_ID}' - URL propia: ${SELF_URL}`)
    addLog("INFO", "START", NODE_ID, `Nodo ${NODE_ID} iniciado en puerto ${PORT} (${SELF_URL})`)

    // Semillas: basta con apuntar al de al lado, el gossip hace el resto
    const seeds = (process.env.PEERS || SEEDS_CLI || process.argv[5] || "")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)

    mergePeerList(seeds)
})