/**
 * server.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Backend Node.js para recibir mensajes de WhatsApp via Twilio
 * y guardarlos en Firestore automáticamente.
 *
 * Flujo: WhatsApp → Twilio → POST /webhook → Firestore → Dashboard
 * ─────────────────────────────────────────────────────────────────────────────
 */

import express        from "express";
import { urlencoded } from "express";
import twilio         from "twilio";
import admin          from "firebase-admin";
import { readFileSync } from "fs";

// ─── FIREBASE ADMIN INIT ──────────────────────────────────────────────────────
const serviceAccount = JSON.parse(
  readFileSync("./serviceAccountKey.json", "utf8")
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// ─── CONSTANTES ───────────────────────────────────────────────────────────────
const ESTADOS_CONSULTA = {
  PENDIENTE:  "pendiente",
  RESPONDIDA: "respondida",
};

const TIPOS = {
  RECETA:      "receta",
  LABORATORIO: "laboratorio",
  CONSULTA:    "consulta",
  URGENCIA:    "urgencia",
};

const SLA_POR_TIPO = {
  receta:      24,
  laboratorio: 48,
  consulta:    72,
  urgencia:     0,
};

// ─── ESTADOS CONVERSACIONALES ─────────────────────────────────────────────────
// Cada paciente tiene un "estadoActual" guardado en la colección "conversaciones"
const ESTADOS_CONV = {
  INICIO:                   "inicio",

  // Receta
  ESPERANDO_MEDICAMENTO:    "esperando_medicamento",
  ESPERANDO_ULTIMA_CONSULTA_RECETA: "esperando_ultima_consulta_receta",

  // Laboratorio
  ESPERANDO_TIPO_LAB:       "esperando_tipo_lab",
  ESPERANDO_ULTIMA_CONSULTA_LAB: "esperando_ultima_consulta_lab",

  // Consulta médica
  ESPERANDO_MOTIVO:         "esperando_motivo",
  ESPERANDO_ULTIMA_CONSULTA_CONS: "esperando_ultima_consulta_cons",
};

const DOCTOR_ID_DEFAULT = "9HYXxu0tHsO5gTnLTBivUyYoATm2";

// ─── MENSAJES ─────────────────────────────────────────────────────────────────
const MENU_INICIAL = `Hola 👋 Para poder ayudarte, elegí una opción:

1 · Receta
2 · Laboratorio
3 · Consulta médica
4 · Urgencia`;

const RESPUESTA_URGENCIA = `🚨 Para urgencias, dirigite a la guardia más cercana o llamá al SAME (107).
Este canal no tiene atención inmediata.`;

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function formatearNumero(from) {
  return from.replace("whatsapp:", "");
}

function calcularSlaDeadline(tipo) {
  const horas = SLA_POR_TIPO[tipo] ?? 72;
  const ahora = new Date();
  return new Date(ahora.getTime() + horas * 60 * 60 * 1000);
}

/**
 * Parsea el primer mensaje del usuario para detectar opción de menú.
 * Acepta número (1–4) o texto parcial.
 */
function parsearOpcionMenu(mensaje) {
  const m = mensaje.trim().toLowerCase();

  if (m === "1" || m.includes("receta"))                             return TIPOS.RECETA;
  if (m === "2" || m.includes("laboratorio") || m.includes("lab"))  return TIPOS.LABORATORIO;
  if (m === "3" || m.includes("consulta"))                          return TIPOS.CONSULTA;
  if (m === "4" || m.includes("urgencia"))                          return TIPOS.URGENCIA;

  return null;
}

// ─── COLECCIÓN CONVERSACIONES ─────────────────────────────────────────────────

/**
 * Obtiene la conversación activa de un paciente (por teléfono).
 * Retorna null si no existe.
 */
async function obtenerConversacion(telefono) {
  const ref = db.collection("conversaciones").doc(telefono);
  const snap = await ref.get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

/**
 * Crea o actualiza el estado conversacional de un paciente.
 */
async function guardarConversacion(telefono, datos) {
  const ref = db.collection("conversaciones").doc(telefono);
  await ref.set(
    {
      telefono,
      ...datos,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

/**
 * Elimina la conversación activa (flujo completado o cancelado).
 */
async function eliminarConversacion(telefono) {
  await db.collection("conversaciones").doc(telefono).delete();
}

// ─── GUARDAR CONSULTA FINAL EN FIRESTORE ──────────────────────────────────────

async function crearConsulta({ nombrePaciente, numeroPaciente, tipo, datos }) {
  const slaDeadline = calcularSlaDeadline(tipo);

  const payload = {
    // ── Paciente ── idéntico al schema de consultasService.crear()
    pacienteNombre:   nombrePaciente,   // dashboard lee: pacienteNombre ✓

    // ── Tipo y contenido ──
    tipo,                               // dashboard lee: tipo ✓
    datos:            datos || {},      // dashboard lee: datos ✓

    // ── Estado ──
    estado:       "pendiente",          // dashboard filtra por: estado ✓
    respondidaEn: null,

    // ── Timestamps ── serverTimestamp() para que Firestore los genere
    createdAt:     admin.firestore.FieldValue.serverTimestamp(),
    fechaCreacion: admin.firestore.FieldValue.serverTimestamp(),

    // ── SLA ── dashboard ordena por slaDeadline ASC
    slaHoras:    SLA_POR_TIPO[tipo] ?? 72,
    slaDeadline: admin.firestore.Timestamp.fromDate(slaDeadline), // dashboard lee: slaDeadline ✓

    // ── Pago ──
    pagado:       false,
    requierePago: tipo === "receta" || tipo === "laboratorio",    // dashboard lee: requierePago ✓

    // ── Trazabilidad ──
    // CRÍTICO: debe ser el uid exacto del médico en Firebase Auth
    // Verificar en: Firebase Console → Authentication → Users → UID
    doctorId: "9HYXxu0tHsO5gTnLTBivUyYoATm2",      // dashboard filtra: where("doctorId", "==", uid) ✓
    origen:   "whatsapp",               // dashboard muestra badge WhatsApp ✓
  };

  const docRef = await db.collection("consultas").add(payload);
  console.log(`[webhook] Consulta guardada: ${docRef.id} (tipo: ${tipo})`);
  return docRef;
}

// ─── MÁQUINA DE ESTADOS ───────────────────────────────────────────────────────

/**
 * Procesa el mensaje del paciente según su estado conversacional actual.
 * Retorna el texto que se enviará de vuelta por WhatsApp.
 */
async function procesarMensaje({ mensaje, telefono, nombrePaciente }) {
  const conv = await obtenerConversacion(telefono);

  // ── Sin conversación activa → mostrar menú ────────────────────────────────
  if (!conv) {
    const tipo = parsearOpcionMenu(mensaje);

    if (tipo === TIPOS.URGENCIA) {
      return RESPUESTA_URGENCIA;
    }

    if (tipo === TIPOS.RECETA) {
      await guardarConversacion(telefono, {
        estadoActual:   ESTADOS_CONV.ESPERANDO_MEDICAMENTO,
        tipoConsulta:   TIPOS.RECETA,
        datosParciales: {},
        nombrePaciente,
      });
      return "¿Cuál es el medicamento y dosis que necesitás?";
    }

    if (tipo === TIPOS.LABORATORIO) {
      await guardarConversacion(telefono, {
        estadoActual:   ESTADOS_CONV.ESPERANDO_TIPO_LAB,
        tipoConsulta:   TIPOS.LABORATORIO,
        datosParciales: {},
        nombrePaciente,
      });
      return "¿Qué tipo de análisis necesitás? (por ejemplo: hemograma, glucemia, orina, etc.)";
    }

    if (tipo === TIPOS.CONSULTA) {
      await guardarConversacion(telefono, {
        estadoActual:   ESTADOS_CONV.ESPERANDO_MOTIVO,
        tipoConsulta:   TIPOS.CONSULTA,
        datosParciales: {},
        nombrePaciente,
      });
      return "¿Cuál es el motivo de tu consulta?";
    }

    // Opción no reconocida
    return MENU_INICIAL;
  }

  // ── Con conversación activa → continuar flujo ─────────────────────────────
  const { estadoActual, tipoConsulta, datosParciales = {} } = conv;

  // ── FLUJO RECETA ──────────────────────────────────────────────────────────
  if (estadoActual === ESTADOS_CONV.ESPERANDO_MEDICAMENTO) {
    await guardarConversacion(telefono, {
      estadoActual:   ESTADOS_CONV.ESPERANDO_ULTIMA_CONSULTA_RECETA,
      datosParciales: { ...datosParciales, medicamento: mensaje },
    });
    return "¿Cuándo fue tu última consulta con el médico?";
  }

  if (estadoActual === ESTADOS_CONV.ESPERANDO_ULTIMA_CONSULTA_RECETA) {
    const datosFinales = { ...datosParciales, ultimaConsulta: mensaje };
    await crearConsulta({
      nombrePaciente: conv.nombrePaciente || nombrePaciente,
      numeroPaciente: telefono,
      tipo:           tipoConsulta,
      datos:          datosFinales,
    });
    await eliminarConversacion(telefono);
    return "✅ Solicitud de receta recibida. El médico te responde dentro de las 24 hs.";
  }

  // ── FLUJO LABORATORIO ─────────────────────────────────────────────────────
  if (estadoActual === ESTADOS_CONV.ESPERANDO_TIPO_LAB) {
    await guardarConversacion(telefono, {
      estadoActual:   ESTADOS_CONV.ESPERANDO_ULTIMA_CONSULTA_LAB,
      datosParciales: { ...datosParciales, tipoAnalisis: mensaje },
    });
    return "¿Cuándo fue tu última consulta con el médico?";
  }

  if (estadoActual === ESTADOS_CONV.ESPERANDO_ULTIMA_CONSULTA_LAB) {
    const datosFinales = { ...datosParciales, ultimaConsulta: mensaje };
    await crearConsulta({
      nombrePaciente: conv.nombrePaciente || nombrePaciente,
      numeroPaciente: telefono,
      tipo:           tipoConsulta,
      datos:          datosFinales,
    });
    await eliminarConversacion(telefono);
    return "✅ Solicitud de laboratorio recibida. El médico te responde dentro de las 48 hs.";
  }

  // ── FLUJO CONSULTA MÉDICA ─────────────────────────────────────────────────
  if (estadoActual === ESTADOS_CONV.ESPERANDO_MOTIVO) {
    await guardarConversacion(telefono, {
      estadoActual:   ESTADOS_CONV.ESPERANDO_ULTIMA_CONSULTA_CONS,
      datosParciales: { ...datosParciales, motivo: mensaje },
    });
    return "¿Cuándo fue tu última consulta con el médico?";
  }

  if (estadoActual === ESTADOS_CONV.ESPERANDO_ULTIMA_CONSULTA_CONS) {
    const datosFinales = { ...datosParciales, ultimaConsulta: mensaje };
    await crearConsulta({
      nombrePaciente: conv.nombrePaciente || nombrePaciente,
      numeroPaciente: telefono,
      tipo:           tipoConsulta,
      datos:          datosFinales,
    });
    await eliminarConversacion(telefono);
    return "✅ Consulta médica recibida. El médico te responde dentro de las 72 hs.";
  }

  // Estado desconocido → resetear y mostrar menú
  console.warn(`[webhook] Estado desconocido "${estadoActual}" para ${telefono}. Reseteando.`);
  await eliminarConversacion(telefono);
  return MENU_INICIAL;
}

// ─── EXPRESS APP ──────────────────────────────────────────────────────────────
const app = express();
app.use(urlencoded({ extended: false }));
app.use(express.json());

// ─── WEBHOOK ──────────────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const mensajeRecibido = (req.body.Body        || "").trim();
  const from            = (req.body.From        || "").trim();
  const profileName     = (req.body.ProfileName || "").trim();

  const numeroPaciente = formatearNumero(from);
  const nombrePaciente = profileName || numeroPaciente;

  console.log(`[webhook] Mensaje de ${nombrePaciente} (${numeroPaciente}): "${mensajeRecibido}"`);

  const twiml = new twilio.twiml.MessagingResponse();

  try {
    const respuesta = await procesarMensaje({
      mensaje:       mensajeRecibido,
      telefono:      numeroPaciente,
      nombrePaciente,
    });
    twiml.message(respuesta);
  } catch (err) {
    console.error("[webhook] Error:", err);
    twiml.message("Hubo un error al procesar tu mensaje. Por favor, intentá de nuevo.");
  }

  res.type("text/xml").send(twiml.toString());
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── SERVIDOR ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor corriendo en http://localhost:${PORT}`);
  console.log(`📡 Webhook disponible en http://localhost:${PORT}/webhook`);
});