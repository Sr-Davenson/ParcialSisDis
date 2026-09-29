// ==========================================
// PANEL DEL MIDDLEWARE (Gregorio Samsa)
// Este script se carga en TODAS las páginas y cada bloque solo
// se activa si encuentra sus elementos en el DOM.
// ==========================================

const createNameInput = document.getElementById("create-name");
const btnCreate = document.getElementById("btn-create");
const createStatus = document.getElementById("create-status");
const serversTable = document.getElementById("servers-table");

const bullyPanel = document.getElementById("bully-panel");
const bullySelf = document.getElementById("bully-self");
const bullyNodes = document.getElementById("bully-nodes");
const peerUrlInput = document.getElementById("peer-url");
const btnAddPeer = document.getElementById("btn-add-peer");
const peerStatus = document.getElementById("peer-status");

function escapeHtml(text) {
    return String(text)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

function showCreateStatus(text, type) {
    if (!createStatus) return;
    createStatus.textContent = text;
    createStatus.className = `status-box ${type}`;
}

// ==========================================
// PANEL BULLY: estado del clúster y botones
// ==========================================
// Todo pasa por NUESTRO coordinador (/cluster-status y /cluster/:id/:accion).
// Es a propósito: con ngrok cada nodo vive en un dominio distinto y puede
// mezclar https con http, así que si el navegador intentara hablar
// directamente con los otros nodos chocaría con CORS y mixed content.

let bullyOcupado = false;

async function cargarEstadoBully() {
    if (!bullyPanel || bullyOcupado) return;

    try {
        const res = await fetch("/cluster-status");
        const data = await res.json();

        // Cabecera: quién soy y en qué estado estoy
        let resumen = "";

        if (data.suspended) {
            resumen = `Soy <strong>coord-${data.selfId}</strong> — 💀 SUSPENDIDO (no participo en la red)`;
        } else if (data.role === "leader") {
            resumen = `Soy <strong>coord-${data.selfId}</strong> — 🟢 SOY EL LÍDER`;
        } else if (data.role === "candidate") {
            resumen = `Soy <strong>coord-${data.selfId}</strong> — 🗳️ elección en curso...`;
        } else {
            const lider = data.leaderId ? `coord-${data.leaderId}` : "sin líder todavía";
            resumen = `Soy <strong>coord-${data.selfId}</strong> — líder actual: ${escapeHtml(lider)}`;
        }

        resumen += `<br><small style="color:#64748b;">${escapeHtml(data.selfUrl || "")}</small>`;
        bullySelf.innerHTML = resumen;

        // Un renglón por nodo, con el botón que corresponda a su estado
        bullyNodes.innerHTML = data.nodes.map(node => {
            const etiquetas = [];
            if (node.self) etiquetas.push("yo");
            if (node.isLeader && node.alive) etiquetas.push("líder");
            const sufijo = etiquetas.length ? ` (${etiquetas.join(", ")})` : "";

            const estado = node.alive
                ? '<span class="active">🟢 ACTIVO</span>'
                : '<span class="offline">💀 CAÍDO</span>';

            // Vivo -> se puede matar. Caído -> se puede reconectar.
            const boton = node.alive
                ? `<button class="danger small" onclick="accionCoordinador(${node.id}, 'kill')">☠ Matar</button>`
                : `<button class="accent small" onclick="accionCoordinador(${node.id}, 'revive')">⟳ Reconectar</button>`;

            return `
                <li style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding:6px 0; border-bottom:1px solid #1e293b; flex-wrap:wrap;">
                    <span style="font-size:13px; color:#cbd5e1;">
                        <strong>coord-${node.id}</strong>${sufijo}
                        <br><small style="color:#64748b;">${escapeHtml(node.url)}</small>
                    </span>
                    <span style="display:flex; align-items:center; gap:10px;">
                        ${estado}
                        ${boton}
                    </span>
                </li>
            `;
        }).join("");
    } catch (error) {
        console.error("Error al cargar el estado del clúster:", error);
        if (bullySelf) bullySelf.textContent = "No se pudo contactar a este coordinador.";
    }
}

// Manda la orden de matar/reconectar a través de nuestro propio coordinador
async function accionCoordinador(id, accion) {
    const esMatar = accion === "kill";
    const mensaje = esMatar
        ? `¿Suspender a coord-${id}? Dejará de participar en el clúster (su interfaz seguirá viva) y se probará la reelección.`
        : `¿Reconectar a coord-${id}? Volverá a participar y podría retomar el liderazgo si tiene el ID más alto.`;

    if (!confirm(mensaje)) return;

    // Pausamos el refresco automático para que no pise el resultado
    bullyOcupado = true;

    try {
        const res = await fetch(`/cluster/${id}/${accion}`, { method: "POST" });
        const data = await res.json();

        if (!res.ok) alert(data.error || "No se pudo completar la acción");
    } catch (error) {
        console.error("Error al contactar al coordinador:", error);
        alert("No se pudo contactar a este coordinador");
    }

    bullyOcupado = false;

    // Le damos un momento al clúster para reelegir antes de volver a pintar
    setTimeout(cargarEstadoBully, 1200);
    setTimeout(cargarEstadoBully, 3500);
}

// Unirse a la red pegando la URL de cualquier nodo que ya esté dentro.
// No hace falta que sea el líder ni conocer a todos: el resto se descubre
// solo por gossip a través de los pings.
async function agregarPeer() {
    if (!peerUrlInput) return;

    const url = peerUrlInput.value.trim();
    if (!url) return;

    btnAddPeer.disabled = true;
    peerStatus.textContent = "Conectando...";
    peerStatus.className = "status-box success";

    try {
        const res = await fetch("/cluster/add-peer", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url })
        });

        const data = await res.json();

        if (res.ok) {
            peerStatus.textContent = data.message;
            peerStatus.className = "status-box success";
            peerUrlInput.value = "";
            cargarEstadoBully();
        } else {
            peerStatus.textContent = data.error || "No se pudo conectar";
            peerStatus.className = "status-box error";
        }
    } catch (error) {
        console.error("Error al agregar peer:", error);
        peerStatus.textContent = "No se pudo contactar a este coordinador";
        peerStatus.className = "status-box error";
    }

    btnAddPeer.disabled = false;
}

if (btnAddPeer) {
    btnAddPeer.addEventListener("click", agregarPeer);
    peerUrlInput.addEventListener("keydown", e => {
        if (e.key === "Enter") agregarPeer();
    });
}

if (bullyPanel) {
    cargarEstadoBully();
    setInterval(cargarEstadoBully, 3000);
}

// ==========================================
// CONTADORES DEL MONITOR
// ==========================================

async function cargarStats() {
    const activo = document.getElementById("stat-active");
    if (!activo) return;

    try {
        const res = await fetch("/api/stats");
        const s = await res.json();

        activo.textContent = s.active;
        document.getElementById("stat-offline").textContent = s.offline;
        document.getElementById("stat-local").textContent = s.local;
        document.getElementById("stat-logs").textContent = s.logs;
        document.getElementById("stat-messages").textContent = s.messages;
    } catch (error) {
        console.error("Error al cargar estadísticas:", error);
    }
}

if (document.getElementById("stat-active")) {
    cargarStats();
    setInterval(cargarStats, 3000);
}

// ==========================================
// CREAR / LISTAR / ELIMINAR MINI SERVERS
// ==========================================

async function crearServidor() {
    if (!createNameInput) return;

    const name = createNameInput.value.trim();
    if (!name) return;

    btnCreate.disabled = true;

    try {
        const res = await fetch("/create-server", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name })
        });

        const data = await res.json();

        if (res.ok) {
            showCreateStatus(data.message, "success");
            createNameInput.value = "";
            cargarServidores();
        } else {
            // Si este nodo no es el líder, el backend nos dice quién sí lo es
            const extra = data.leaderUrl ? ` Abre el panel del líder: ${data.leaderUrl}` : "";
            showCreateStatus((data.error || "Error") + extra, "error");
        }
    } catch (error) {
        console.error("Error al crear el servidor:", error);
        showCreateStatus("No se pudo contactar al Middleware", "error");
    }

    btnCreate.disabled = false;
}

async function matarServidor(name) {
    if (!confirm(`¿Detener/eliminar "${name}"?`)) return;

    try {
        const res = await fetch(`/kill-server/${encodeURIComponent(name)}`, { method: "POST" });
        const data = await res.json();

        if (!res.ok) alert(data.error || "No se pudo eliminar el servidor");

        cargarServidores();
    } catch (error) {
        console.error("Error al eliminar el servidor:", error);
    }
}

async function cargarServidores() {
    if (!serversTable) return;

    try {
        const res = await fetch("/api/servers");
        const list = await res.json();

        if (!list.length) {
            serversTable.innerHTML = "<p>No hay servidores registrados en este coordinador.</p>";
            return;
        }

        const rows = list.map(server => {
            const seconds = Math.floor((Date.now() - server.lastHeartbeat) / 1000);
            const isOffline = server.status === "offline";

            return `
                <tr>
                    <td>${escapeHtml(server.name)}</td>
                    <td><a href="${encodeURI(server.url)}" target="_blank">${escapeHtml(server.url)}</a></td>
                    <td>${escapeHtml(server.owner || "?")}</td>
                    <td>${server.local ? "Local" : "Remoto"}</td>
                    <td>Hace ${seconds}s</td>
                    <td class="${isOffline ? "offline" : "active"}">${isOffline ? "🔴 OFFLINE" : "🟢 ACTIVO"}</td>
                    <td>${server.messageCount}</td>
                    <td><button class="danger small" onclick="matarServidor('${server.name}')">Eliminar</button></td>
                </tr>
            `;
        }).join("");

        serversTable.innerHTML = `
            <table>
                <tr>
                    <th>Servidor</th>
                    <th>URL</th>
                    <th>Dueño</th>
                    <th>Tipo</th>
                    <th>Último Pulse</th>
                    <th>Estado</th>
                    <th>Msjs</th>
                    <th></th>
                </tr>
                ${rows}
            </table>
        `;
    } catch (error) {
        console.error("Error al cargar servidores:", error);
        serversTable.innerHTML = "<p>No se pudo cargar la lista de servidores.</p>";
    }
}

if (btnCreate) {
    btnCreate.addEventListener("click", crearServidor);
    createNameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") crearServidor();
    });

    cargarServidores();
    setInterval(cargarServidores, 3000);
}