// ==========================================
// PÁGINA DE TAREAS DEL COORDINADOR
// Usa: POST /task/dispatch, GET /task/results, GET /task/workers,
// POST /task/workers/refresh y GET /election/state.
// ==========================================

const BASE_TASK_TYPES = [
    "math_compute",
    "http_fetch",
    "search_text",
    "stats_compute",
    "vector_distance",
    "http_latency",
    "text_transform"
];

const workerSelect = document.getElementById("task-worker");
const typeSelect = document.getElementById("task-type");
const fieldsBox = document.getElementById("task-fields");
const btnAssign = document.getElementById("btn-assign");
const btnRefreshCaps = document.getElementById("btn-refresh-caps");
const assignStatus = document.getElementById("assign-status");
const tasksTable = document.getElementById("tasks-table");
const workersTable = document.getElementById("workers-table");
const leaderBanner = document.getElementById("leader-banner");

let workers = [];
let discoveredCatalog = {}; // type -> { type, description, payload, samplePayload, result }

function escapeHtml(text) {
    return String(text)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

function showAssign(text, type) {
    assignStatus.textContent = text;
    assignStatus.className = `status-box ${type}`;
}

// ---------- Formulario según el tipo de tarea ----------

const FORMS = {
    math_compute: `
        <label><span class="field-label">Operación</span>
            <select id="f-operation">
                <option value="add">add (+)</option>
                <option value="sub">sub (−)</option>
                <option value="mul">mul (×)</option>
                <option value="div">div (÷)</option>
            </select></label>
        <label><span class="field-label">a</span><input type="number" step="any" id="f-a" value="10"></label>
        <label><span class="field-label">b</span><input type="number" step="any" id="f-b" value="5"></label>
    `,
    http_fetch: `
        <label class="grow"><span class="field-label">URL</span><input type="text" id="f-url" value="https://example.com"></label>
    `,
    search_text: `
        <label class="grow"><span class="field-label">Texto</span><input type="text" id="f-text" value="hola mundo hola"></label>
        <label><span class="field-label">Buscar (query)</span><input type="text" id="f-query" value="hola"></label>
    `,
    stats_compute: `
        <label class="grow"><span class="field-label">Números (separados por coma)</span><input type="text" id="f-numbers" value="1, 2, 3, 4, 5"></label>
    `,
    vector_distance: `
        <label><span class="field-label">a · x</span><input type="number" step="any" id="f-ax" value="0"></label>
        <label><span class="field-label">a · y</span><input type="number" step="any" id="f-ay" value="0"></label>
        <label><span class="field-label">b · x</span><input type="number" step="any" id="f-bx" value="3"></label>
        <label><span class="field-label">b · y</span><input type="number" step="any" id="f-by" value="4"></label>
    `,
    http_latency: `
        <label class="grow"><span class="field-label">URL</span><input type="text" id="f-url" value="https://example.com"></label>
    `,
    text_transform: `
        <label><span class="field-label">Modo</span>
            <select id="f-tt-mode">
                <option value="upper">upper (MAYÚSCULAS)</option>
                <option value="lower">lower (minúsculas)</option>
                <option value="reverse">reverse (invertir)</option>
            </select></label>
        <label class="grow"><span class="field-label">Texto</span><input type="text" id="f-tt-text" value="hola mundo distribuido"></label>
    `
};

function renderFields() {
    const selected = typeSelect.value;
    if (FORMS[selected]) {
        fieldsBox.innerHTML = FORMS[selected];
        return;
    }

    // Tarea dinámica descubierta o no registrada en FORMS fijos
    const info = discoveredCatalog[selected] || {};
    const schema = info.payload || {};
    const sample = info.samplePayload || {};
    
    let generatedHtml = "";
    
    if (Object.keys(schema).length === 0) {
        // Si no hay esquema, mostramos el JSON genérico como fallback extremo
        const sampleStr = JSON.stringify(sample, null, 2);
        generatedHtml = `
            <label class="grow">
                <span class="field-label">Payload (JSON para '${escapeHtml(selected)}')</span>
                <textarea id="f-dynamic-json" rows="4" style="font-family:Consolas, monospace; width:100%; padding:8px 10px; border-radius:6px; background:#0f172a; color:#f8fafc; border:1px solid #475569; font-size:13px;">${escapeHtml(sampleStr)}</textarea>
            </label>
        `;
    } else {
        // Generar inputs dinámicamente según el esquema
        for (const [key, typeString] of Object.entries(schema)) {
            const val = sample[key] !== undefined ? sample[key] : "";
            
            // Si el tipo contiene un pipe "|", es un selector (enum)
            if (typeof typeString === "string" && typeString.includes("|")) {
                const options = typeString.split("|").map(s => s.trim());
                const optionsHtml = options.map(opt => 
                    `<option value="${escapeHtml(opt)}" ${val === opt ? "selected" : ""}>${escapeHtml(opt)}</option>`
                ).join("");
                
                generatedHtml += `
                    <label>
                        <span class="field-label">${escapeHtml(key)}</span>
                        <select data-dynamic-field="${escapeHtml(key)}">
                            ${optionsHtml}
                        </select>
                    </label>
                `;
            } else if (typeof typeString === "string" && typeString.includes("number")) {
                generatedHtml += `
                    <label>
                        <span class="field-label">${escapeHtml(key)}</span>
                        <input type="number" step="any" data-dynamic-field="${escapeHtml(key)}" value="${escapeHtml(val)}">
                    </label>
                `;
            } else {
                generatedHtml += `
                    <label class="grow">
                        <span class="field-label">${escapeHtml(key)}</span>
                        <input type="text" data-dynamic-field="${escapeHtml(key)}" value="${escapeHtml(val)}">
                    </label>
                `;
            }
        }
    }

    const schemaStr = info.payload ? JSON.stringify(info.payload) : "No especificado";

    fieldsBox.innerHTML = `
        <div style="width:100%; display:flex; flex-direction:column; gap:8px;">
            <div style="font-size:12px; color:#94a3b8; background:#0f172a; padding:8px 12px; border-radius:6px; border:1px solid #334155; margin-bottom: 8px;">
                <div><strong>Descripción:</strong> ${escapeHtml(info.description || "Tarea dinámica detectada desde workers")}</div>
                <div><strong>Esquema detectado:</strong> <code>${escapeHtml(schemaStr)}</code></div>
            </div>
            <div style="display:flex; flex-wrap:wrap; gap:12px; width:100%;">
                ${generatedHtml}
            </div>
        </div>
    `;
}

// Devuelve el payload o lanza un Error con el mensaje para el usuario
function readPayload() {
    // Si la tarea se está editando mediante el JSON dinámico extremo (fallback):
    const dynamicJsonEl = document.getElementById("f-dynamic-json");
    if (dynamicJsonEl) {
        try {
            const parsed = JSON.parse(dynamicJsonEl.value);
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
                throw new Error("El JSON debe ser un objeto {}");
            }
            return parsed;
        } catch (e) {
            throw new Error("Payload JSON inválido: " + (e.message || "revisa la sintaxis"));
        }
    }

    // Si la tarea se está editando mediante los campos dinámicos generados automáticamente:
    const dynamicFields = document.querySelectorAll("[data-dynamic-field]");
    if (dynamicFields.length > 0) {
        const payload = {};
        dynamicFields.forEach(el => {
            const key = el.getAttribute("data-dynamic-field");
            let val = el.value.trim();
            if (el.type === "number") {
                if (val === "" || !Number.isFinite(Number(val))) throw new Error(`El campo '${key}' debe ser un número`);
                val = Number(val);
            }
            payload[key] = val;
        });
        return payload;
    }

    const num = (id, label) => {
        const raw = document.getElementById(id).value.trim();
        if (raw === "" || !Number.isFinite(Number(raw))) throw new Error(`${label} debe ser un número`);
        return Number(raw);
    };

    const url = () => {
        const value = document.getElementById("f-url").value.trim();
        if (!/^https?:\/\/.+/i.test(value)) throw new Error("La URL debe empezar con http:// o https://");
        return value;
    };

    switch (typeSelect.value) {
        case "math_compute":
            return {
                operation: document.getElementById("f-operation").value,
                a: num("f-a", "a"),
                b: num("f-b", "b")
            };
        case "http_fetch":
        case "http_latency":
            return { url: url() };
        case "search_text": {
            const query = document.getElementById("f-query").value;
            if (!query) throw new Error("La búsqueda (query) no puede estar vacía");
            return { text: document.getElementById("f-text").value, query };
        }
        case "stats_compute": {
            const parts = document.getElementById("f-numbers").value.split(/[\s,;]+/).filter(Boolean);
            if (!parts.length) throw new Error("Escribe al menos un número");
            const numbers = parts.map(Number);
            if (numbers.some(n => !Number.isFinite(n))) throw new Error("Solo se permiten números separados por coma");
            return { numbers };
        }
        case "vector_distance":
            return {
                a: [num("f-ax", "a·x"), num("f-ay", "a·y")],
                b: [num("f-bx", "b·x"), num("f-by", "b·y")]
            };
        case "text_transform": {
            const text = document.getElementById("f-tt-text").value;
            const mode = document.getElementById("f-tt-mode").value;
            if (!text || !text.trim()) throw new Error("El texto no puede estar vacío");
            return { text, mode };
        }
        default:
            throw new Error(`Tipo de tarea no configurado: ${typeSelect.value}`);
    }
}

typeSelect.addEventListener("change", () => {
    renderFields();
    renderWorkerSelect(true);
});
renderFields();

// ---------- Asignar ----------

btnAssign.addEventListener("click", async () => {
    let payload;
    try {
        payload = readPayload();
    } catch (error) {
        return showAssign(error.message, "error");
    }

    btnAssign.disabled = true;

    try {
        const res = await fetch("/task/dispatch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // worker vacío = automático: el coordinador elige uno que soporte la tarea
            body: JSON.stringify({ worker: workerSelect.value || undefined, type: typeSelect.value, payload })
        });
        const data = await res.json();

        if (res.ok) {
            showAssign(`${data.taskId} asignada a ${data.worker}. El worker tarda ~2s en responder.`, "success");
            cargarTareas();
        } else {
            showAssign(data.error || "No se pudo asignar la tarea", "error");
        }
    } catch (error) {
        console.error("Error al asignar la tarea:", error);
        showAssign("No se pudo contactar a este coordinador", "error");
    }

    btnAssign.disabled = false;
});

// ---------- Workers y capacidades ----------

// true = soporta, false = no soporta, null = todavía no sabemos
function soporta(worker, type) {
    if (!worker.capabilities) return null;
    return worker.capabilities.includes(type);
}

function getAllTaskTypes() {
    return [...new Set([...BASE_TASK_TYPES, ...Object.keys(discoveredCatalog)])];
}

function updateCatalogAndTypes() {
    workers.forEach(w => {
        (w.capabilitiesDetails || []).forEach(d => {
            if (d && d.type) {
                discoveredCatalog[d.type] = d;
            }
        });
        (w.capabilities || []).forEach(capName => {
            if (!discoveredCatalog[capName]) {
                discoveredCatalog[capName] = { type: capName, description: "Capacidad reportada por worker" };
            }
        });
    });

    const allTypes = getAllTaskTypes();
    const currentSelected = typeSelect.value;
    const currentOptions = Array.from(typeSelect.options).map(o => o.value);
    const hasChanged = allTypes.length !== currentOptions.length || allTypes.some((t, i) => t !== currentOptions[i]);

    if (hasChanged) {
        typeSelect.innerHTML = allTypes.map(t => {
            const info = discoveredCatalog[t] || {};
            const desc = info.description ? ` — ${info.description}` : "";
            return `<option value="${escapeHtml(t)}">${escapeHtml(t)}${escapeHtml(desc)}</option>`;
        }).join("");

        if (allTypes.includes(currentSelected)) {
            typeSelect.value = currentSelected;
        }
        renderFields();
    }
}

let selectKey = "";

// Lista para el tipo de tarea elegido: los que no la soportan salen deshabilitados
function renderWorkerSelect(force) {
    const type = typeSelect.value;
    const online = workers.filter(w => w.status === "online");

    const key = type + "|" + online.map(w => `${w.name}:${soporta(w, type)}`).join(",");
    if (!force && key === selectKey) return;
    selectKey = key;

    const previous = workerSelect.value;

    const options = ['<option value="">🤖 Automático (el coordinador elige)</option>'];
    online.forEach(w => {
        const ok = soporta(w, type);
        const label = ok === false ? `${w.name} — no soporta ${type}`
            : ok === null ? `${w.name} (capacidades sin confirmar)`
            : w.name;
        options.push(`<option value="${escapeHtml(w.name)}"${ok === false ? " disabled" : ""}>${escapeHtml(label)}</option>`);
    });
    workerSelect.innerHTML = options.join("");

    const stillValid = online.some(w => w.name === previous && soporta(w, type) !== false);
    workerSelect.value = stillValid ? previous : "";
}

function renderWorkersTable() {
    if (!workers.length) {
        workersTable.innerHTML = "<p>No hay workers registrados.</p>";
        return;
    }

    const allTypes = getAllTaskTypes();

    const rows = workers.map(w => {
        const online = w.status === "online";
        const pills = allTypes.map(t => {
            const ok = soporta(w, t);
            const cls = ok === null ? "unknown" : ok ? "on" : "off";
            const mark = ok === null ? "?" : ok ? "✓" : "✗";
            return `<span class="cap ${cls}">${mark} ${t}</span>`;
        }).join("");

        const errorHtml = w.capabilitiesError
            ? `<div class="info-extra" style="color:#f87171;">No se pudieron consultar sus capacidades: ${escapeHtml(w.capabilitiesError)}</div>`
            : "";

        return `
            <tr>
                <td><strong>${escapeHtml(w.name)}</strong><br><small style="color:#64748b;">${escapeHtml(w.url)}</small></td>
                <td class="${online ? "active" : "offline"}">${online ? "🟢 ONLINE" : "🔴 OFFLINE"}</td>
                <td>${pills}${errorHtml}</td>
            </tr>
        `;
    }).join("");

    workersTable.innerHTML = `
        <div style="overflow-x:auto;">
            <table>
                <tr><th>Worker</th><th>Estado</th><th>Tareas que sabe hacer</th></tr>
                ${rows}
            </table>
        </div>
    `;
}

async function cargarWorkers() {
    try {
        const res = await fetch("/task/workers");
        workers = await res.json();
        updateCatalogAndTypes();
        renderWorkersTable();
        renderWorkerSelect(false);
    } catch (error) {
        console.error("Error al cargar workers:", error);
    }
}

btnRefreshCaps.addEventListener("click", async () => {
    btnRefreshCaps.disabled = true;
    btnRefreshCaps.textContent = "Consultando...";

    try {
        const res = await fetch("/task/workers/refresh", { method: "POST" });
        workers = await res.json();
        updateCatalogAndTypes();
        renderWorkersTable();
        renderWorkerSelect(true);
    } catch (error) {
        console.error("Error al actualizar capacidades:", error);
    }

    btnRefreshCaps.disabled = false;
    btnRefreshCaps.textContent = "Actualizar capacidades";
});

// ---------- Aviso de líder ----------

async function cargarLider() {
    try {
        const res = await fetch("/election/state");
        const s = await res.json();

        if (s.paused) {
            leaderBanner.textContent = `Este nodo (${s.id}) está detenido: no participa en la red.`;
            leaderBanner.className = "status-box error";
        } else if (s.role === "leader") {
            leaderBanner.textContent = `Este nodo (${s.id}) es el líder: aquí se asignan las tareas.`;
            leaderBanner.className = "status-box success";
        } else {
            const donde = s.leaderUrl ? ` Abre ${s.leaderUrl}/tareas` : "";
            leaderBanner.textContent = `Este nodo (${s.id}) no es el líder actual (${s.leader || "sin líder"}); sus workers viven en el líder.${donde}`;
            leaderBanner.className = "status-box error";
        }
    } catch (error) {
        leaderBanner.className = "status-box";
    }
}

// ---------- Tabla de tareas ----------

const ESTADOS = {
    assigned:  '<span class="pending">⏳ En proceso</span>',
    completed: '<span class="active">✅ Completada</span>',
    failed:    '<span class="offline">❌ Falló</span>'
};

function recortar(text, max) {
    return text.length > max ? text.slice(0, max) + "…" : text;
}

async function cargarTareas() {
    try {
        const res = await fetch("/task/results");
        const list = await res.json();

        if (!list.length) {
            tasksTable.innerHTML = "<p>Todavía no hay tareas.</p>";
            return;
        }

        const rows = list.map(t => {
            const duracion = t.finishedAt && t.assignedAt
                ? `${((t.finishedAt - t.assignedAt) / 1000).toFixed(1)}s`
                : "—";
            const salida = t.status === "completed"
                ? JSON.stringify(t.result)
                : (t.error || "");

            return `
                <tr>
                    <td>${escapeHtml(t.taskId)}</td>
                    <td>${escapeHtml(t.worker)}</td>
                    <td>${escapeHtml(t.type)}</td>
                    <td><code>${escapeHtml(recortar(JSON.stringify(t.payload) || "", 200))}</code></td>
                    <td>${ESTADOS[t.status] || escapeHtml(t.status)}</td>
                    <td><code>${escapeHtml(recortar(salida || "", 300))}</code></td>
                    <td>${duracion}</td>
                </tr>
            `;
        }).join("");

        tasksTable.innerHTML = `
            <div style="overflow-x:auto;">
                <table>
                    <tr>
                        <th>ID</th><th>Worker</th><th>Tipo</th><th>Payload</th>
                        <th>Estado</th><th>Resultado</th><th>Tiempo</th>
                    </tr>
                    ${rows}
                </table>
            </div>
        `;
    } catch (error) {
        console.error("Error al cargar tareas:", error);
    }
}

cargarWorkers();
cargarLider();
cargarTareas();
setInterval(cargarWorkers, 3000);
setInterval(cargarLider, 3000);
setInterval(cargarTareas, 1000);