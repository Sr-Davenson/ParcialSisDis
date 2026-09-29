// Referencias a elementos UI
const serverNameInput = document.getElementById('server-name');
const parentUrlInput = document.getElementById('parent-url');
const btnRegister = document.getElementById('btn-register');
const statusRegister = document.getElementById('status-register');

const inputMensaje = document.getElementById('input-mensaje');
const btnEnviar = document.getElementById('btn-enviar');

const btnApagar = document.getElementById('btn-apagar');
const btnReconectar = document.getElementById('btn-reconectar');
const listaMensajes = document.getElementById('lista-mensajes');

const connectionInfo = document.getElementById('connection-info');
const connectionExtra = document.getElementById('connection-extra');
const tasksInfo = document.getElementById('tasks-info');

// Función para registrar el servidor en el Middleware
btnRegister.addEventListener('click', async () => {
    const serverName = serverNameInput.value.trim();
    const parentUrl = parentUrlInput.value.trim();

    if (!serverName || !parentUrl) {
        showStatus('Nombre y URL del Middleware son obligatorios', 'error');
        return;
    }

    try {
        const response = await fetch('/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ serverName, parentUrl })
        });

        const data = await response.json();

        if (response.ok) {
            showStatus(data.message, 'success');
            // Habilitar controles de pulsos
            btnApagar.disabled = false;
            btnApagar.style.display = 'inline-block';
            btnReconectar.style.display = 'none';
            cargarConexion();
        } else {
            showStatus(data.error, 'error');
        }
    } catch (error) {
        console.error("Detalle del error de red:", error);
        showStatus('Error al conectar con el servidor local', 'error');
    }
});

// Función para enviar mensaje al Middleware
btnEnviar.addEventListener('click', async () => {
    const message = inputMensaje.value.trim();
    if (!message) return alert("Escribe un mensaje primero.");

    try {
        const response = await fetch('/send-message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message })
        });

        const data = await response.json();

        if (response.ok) {
            inputMensaje.value = '';
            obtenerMensajes();
        } else {
            alert(data.error);
        }
    } catch (error) {
        console.error("Error al enviar el mensaje:", error);
    }
});

// Enviar mensaje presionando 'Enter'
inputMensaje.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        btnEnviar.click();
    }
});

// Detener los pulsos (Shutdown)
btnApagar.addEventListener('click', async () => {
    try {
        const response = await fetch('/shutdown', { method: 'POST' });
        const data = await response.json();

        // Alternar botones
        btnApagar.style.display = 'none';
        btnReconectar.style.display = 'inline-block';
       
        alert(data.message);
        cargarConexion();
    } catch (error) {
        console.error("Error al detener pulsos:", error);
    }
});

// Reanudar los pulsos (Resume)
btnReconectar.addEventListener('click', async () => {
    try {
        const response = await fetch('/resume', { method: 'POST' });
        const data = await response.json();

        // Alternar botones
        btnReconectar.style.display = 'none';
        btnApagar.style.display = 'inline-block';
       
        alert(data.message);
        cargarConexion();
    } catch (error) {
        console.error("Error al reanudar pulsos:", error);
    }
});

// Obtener mensajes de la lista local
async function obtenerMensajes() {
    try {
        const response = await fetch('/messages');
        const data = await response.json();

        listaMensajes.innerHTML = '';

        const mensajesInvertidos = [...data.messages].reverse();

        mensajesInvertidos.forEach(msg => {
            const li = document.createElement('li');
            li.textContent = msg;
            listaMensajes.appendChild(li);
        });
    } catch (error) {
        console.error("Error al obtener los mensajes:", error);
    }
}

// Auxiliar para mostrar alertas de estado de registro
function showStatus(text, type) {
    statusRegister.textContent = text;
    statusRegister.className = `status-box ${type}`;
}

// ==========================================
// TARJETA "CONEXIÓN ACTUAL"
// ==========================================

function escapeHtml(text) {
    return String(text)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

function item(label, valueHtml) {
    return `
        <div class="info-item">
            <span class="info-label">${label}</span>
            <span class="info-value">${valueHtml}</span>
        </div>
    `;
}

function hace(timestamp) {
    if (!timestamp) return "nunca";
    const s = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    return `hace ${s}s`;
}

async function cargarConexion() {
    try {
        const res = await fetch('/connection');
        const c = await res.json();

        if (!c.parent) {
            connectionInfo.innerHTML = item("Estado", '<span class="offline">🔴 Sin conexión</span>')
                + item("Este worker", escapeHtml(c.name))
                + item("Coordinador (padre)", "— Todavía no estás registrado en ninguno");
            connectionExtra.textContent = "";
            return;
        }

        const p = c.parentState || {};
        const alcanzable = p.reachable
            ? '<span class="active">🟢 Responde</span>'
            : '<span class="offline">🔴 No responde</span>';

        let pulso;
        if (!c.pulsing) {
            pulso = '<span class="offline">⏸ Detenidos</span>';
        } else if (c.lastPulseError) {
            pulso = `<span class="offline">⚠ Fallando</span> (${escapeHtml(c.lastPulseError)})`;
        } else {
            pulso = c.lastPulseOkAt
                ? `<span class="active">🟢 Enviando</span> · último ${hace(c.lastPulseOkAt)}`
                : '<span class="pending">⏳ Esperando el primer pulso</span>';
        }

        let rol = "—";
        if (p.reachable) {
            rol = p.role === "leader" ? "👑 Líder" : "Seguidor";
            if (p.role !== "leader" && p.leaderId) rol += ` (el líder es ${escapeHtml(p.leaderId)})`;
        }

        connectionInfo.innerHTML =
            item("Coordinador (padre)", `<a href="${encodeURI(c.parent)}" target="_blank">${escapeHtml(c.parent)}</a>`)
            + item("ID del coordinador", p.id ? `coord-${escapeHtml(p.id)}` : "—")
            + item("Rol del coordinador", rol)
            + item("Estado del coordinador", alcanzable)
            + item("Pulsos", pulso)
            + item("Este worker", `${escapeHtml(c.name)}<br><small>${escapeHtml(c.selfUrl)}</small>`);

        // Otros administradores conocidos + últimos cambios de padre
        const admins = (c.knownAdmins || []).filter(a => a.url !== c.parent);
        let extra = "";

        if (admins.length) {
            extra += "<div><strong>Otros coordinadores conocidos:</strong> "
                + admins.map(a => `coord-${escapeHtml(a.id)}`).join(", ") + "</div>";
        }

        if (c.history && c.history.length) {
            extra += "<div><strong>Últimos cambios de padre:</strong></div>"
                + c.history.slice().reverse().map(h =>
                    `<div>· ${new Date(h.time).toLocaleTimeString()} — ${h.from ? escapeHtml(h.from) : "(sin padre)"} → ${escapeHtml(h.to)}</div>`
                ).join("");
        }

        connectionExtra.innerHTML = extra;
    } catch (error) {
        console.error("Error al cargar la conexión:", error);
        connectionInfo.innerHTML = item("Estado", '<span class="offline">No se pudo consultar este worker</span>');
    }
}

// ==========================================
// TARJETA "TAREAS QUE PUEDO REALIZAR"
// ==========================================
async function cargarTareas() {
    try {
        const res = await fetch('/task/capabilities');
        const d = await res.json();

        tasksInfo.innerHTML = (d.details || []).map(t => `
            <div class="info-item">
                <span class="info-label">${escapeHtml(t.type)}</span>
                <span class="info-value">${escapeHtml(t.description)}</span>
                <div class="info-extra">
                    <div><strong>Entrada:</strong> <code>${escapeHtml(JSON.stringify(t.payload))}</code></div>
                    <div><strong>Salida:</strong> <code>${escapeHtml(JSON.stringify(t.result))}</code></div>
                </div>
            </div>
        `).join("") + item("Tareas en ejecución", escapeHtml(d.running));
    } catch (error) {
        console.error("Error al cargar las tareas:", error);
        tasksInfo.innerHTML = item("Estado", '<span class="offline">No se pudieron cargar las tareas</span>');
    }
}

// Al cargar: si el Middleware ya nos lanzó y auto-registró (create-server),
// reflejamos ese estado en la interfaz en vez de mostrar el formulario vacío.
async function cargarEstadoInicial() {
    try {
        const infoRes = await fetch('/info');
        const info = await infoRes.json();
        serverNameInput.value = info.name;

        const parentRes = await fetch('/parent');
        const parentData = await parentRes.json();

        if (parentData.parent) {
            parentUrlInput.value = parentData.parent;
            showStatus(`Ya conectado a ${parentData.parent}`, 'success');
            btnApagar.disabled = false;
            btnApagar.style.display = 'inline-block';
            btnReconectar.style.display = 'none';
        }
    } catch (error) {
        console.error("No se pudo cargar el estado inicial:", error);
    }
}

// Cargar historial de mensajes y estado de conexión al iniciar
obtenerMensajes();
cargarEstadoInicial();
cargarConexion();
setInterval(cargarConexion, 2000);
cargarTareas();
setInterval(cargarTareas, 5000);