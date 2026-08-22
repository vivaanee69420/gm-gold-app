// Dentally client — one interface, three implementations (FR-16):
//
//   syncService ──▶ client.listAppointments / listPatients / listInvoices / getPatient
//                        │
//                        ├── mode 'dentalos': the company's Dental Os Postgres (already fed
//                        │                    by Dentally webhooks) via a read-only role —
//                        │                    the preferred source; no Dentally credentials
//                        ├── mode 'live':  api.dentally.co (Bearer token, User-Agent required,
//                        │                 3-attempt backoff per NFR-04), Dentally JSON mapped
//                        │                 to the normalized shapes below
//                        └── mode 'stub':  in-memory fixtures with the same shapes; dev + tests
//                                          mutate via stubAddPatient / stubAddCompletedTreatment
//
// Normalized shapes (all timestamps ISO strings, phones E.164 or null):
//   appointment { id, patientId, siteId, completedAt, updatedAt }   siteId = Dentally site uuid
//   patient     { id, phone, siteId, updatedAt }                    id: Dental Os contact uuid /
//   invoice     { id, paid, paidOn, amountPennies }                     Dentally patient id (live)
import { normalizePhone } from '@gm-referral/shared/phone';
import { config } from '../../config.js';
import { getAccessToken } from './connectionService.js';

// ---------- live ----------
async function liveGet(path) {
  let lastErr;
  let refreshed = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const token = await getAccessToken({ forceRefresh: refreshed });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(`${config.dentally.apiBase}/v1${path}`, {
        headers: {
          authorization: `Bearer ${token}`,
          'user-agent': 'GM-Referral-Sync v1',
          accept: 'application/json',
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.status === 401 && !refreshed && !config.dentally.token) {
        refreshed = true; // expired OAuth access token — refresh once and retry
        throw new Error('dentally_http_401_refresh');
      }
      if (res.status === 429 || res.status >= 500) throw new Error(`dentally_http_${res.status}`);
      const body = await res.json();
      if (!res.ok) {
        const err = new Error(`dentally_http_${res.status}`);
        err.permanent = true;
        throw err;
      }
      return body;
    } catch (err) {
      lastErr = err;
      if (err.permanent) break;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastErr;
}

const PER_PAGE = 100;
const hasMore = (items) => items.length === PER_PAGE;
const poundsToPennies = (v) => (v == null ? null : Math.round(parseFloat(v) * 100));

const liveClient = {
  async listAppointments({ updatedAfter, page = 1 }) {
    const body = await liveGet(
      `/appointments?updated_after=${encodeURIComponent(updatedAfter)}&per_page=${PER_PAGE}&page=${page}`,
    );
    const items = (body.appointments ?? []).map((a) => ({
      id: String(a.id),
      patientId: String(a.patient_id),
      siteId: a.site_id != null ? String(a.site_id) : null,
      startsAt: a.start_time ?? null,
      cancelled: a.cancelled_at != null,
      completedAt: a.completed_at ?? null,
      updatedAt: a.updated_at ?? null,
    }));
    return { items, hasMore: hasMore(items) };
  },
  async listPatients({ updatedAfter, page = 1 }) {
    const body = await liveGet(
      `/patients?updated_after=${encodeURIComponent(updatedAfter)}&per_page=${PER_PAGE}&page=${page}`,
    );
    const items = (body.patients ?? []).map((p) => ({
      id: String(p.id),
      phone: normalizePhone(p.mobile_phone ?? p.phone_normalized ?? ''),
      siteId: p.site_id != null ? String(p.site_id) : null,
      updatedAt: p.updated_at ?? null,
    }));
    return { items, hasMore: hasMore(items) };
  },
  async getPatient(id) {
    const body = await liveGet(`/patients/${id}`);
    const p = body.patient ?? body;
    if (!p?.id) return null;
    return {
      id: String(p.id),
      phone: normalizePhone(p.mobile_phone ?? p.phone_normalized ?? ''),
      siteId: p.site_id != null ? String(p.site_id) : null,
      updatedAt: p.updated_at ?? null,
    };
  },
  async listInvoices({ patientId }) {
    const body = await liveGet(`/invoices?patient_id=${encodeURIComponent(patientId)}&per_page=${PER_PAGE}`);
    return {
      items: (body.invoices ?? []).map((i) => ({
        id: String(i.id),
        paid: i.paid === true,
        paidOn: i.paid_on ?? null,
        amountPennies: poundsToPennies(i.amount),
      })),
    };
  },
};

// ---------- dentalos: read-only queries against the Dental Os Postgres ----------
// Dental Os shapes → normalized shapes: contacts(phone, practice_id) → patient;
// appointments(status='completed', ends_at) → completed appointment; invoices(paid,
// amount_pence) → invoice. siteId is the TRUE Dentally site uuid (practices.pms_site_id),
// so our practices.dentally_site_id mapping stays valid if we ever switch to direct Dentally.
const DOS_PAGE = 500;
let dosPool = null;

async function dosQuery(text, params) {
  if (!dosPool) {
    const { default: pg } = await import('pg');
    dosPool = new pg.Pool({ connectionString: config.dentally.dentalOsUrl, max: 3 });
  }
  return dosPool.query(text, params);
}

const iso = (v) => (v == null ? null : new Date(v).toISOString());

const dentalOsClient = {
  async listPatients({ updatedAfter }) {
    const { rows } = await dosQuery(
      `select c.id, c.phone, p.pms_site_id as site_id, c.updated_at
       from contacts c left join practices p on p.id = c.practice_id
       where c.updated_at > $1 and c.phone is not null
       order by c.updated_at asc limit ${DOS_PAGE}`,
      [updatedAfter],
    );
    const items = rows.map((r) => ({
      id: String(r.id),
      phone: normalizePhone(r.phone),
      siteId: r.site_id ?? null,
      updatedAt: iso(r.updated_at),
    }));
    return { items, hasMore: items.length === DOS_PAGE };
  },
  async listAppointments({ updatedAfter }) {
    const { rows } = await dosQuery(
      `select a.id, a.contact_id, a.status, a.starts_at, a.ends_at, a.updated_at, p.pms_site_id as site_id
       from appointments a left join practices p on p.id = a.practice_id
       where a.updated_at > $1
       order by a.updated_at asc limit ${DOS_PAGE}`,
      [updatedAfter],
    );
    const items = rows.map((r) => ({
      id: String(r.id),
      patientId: r.contact_id ? String(r.contact_id) : null,
      siteId: r.site_id ?? null,
      startsAt: iso(r.starts_at),
      cancelled: r.status === 'cancelled',
      completedAt: r.status === 'completed' ? iso(r.ends_at ?? r.updated_at) : null,
      updatedAt: iso(r.updated_at),
    }));
    return { items, hasMore: items.length === DOS_PAGE };
  },
  async getPatient(id) {
    if (!id) return null;
    const { rows } = await dosQuery(
      `select c.id, c.phone, p.pms_site_id as site_id, c.updated_at
       from contacts c left join practices p on p.id = c.practice_id
       where c.id = $1`,
      [id],
    );
    const r = rows[0];
    return r
      ? { id: String(r.id), phone: normalizePhone(r.phone ?? ''), siteId: r.site_id ?? null, updatedAt: iso(r.updated_at) }
      : null;
  },
  async listInvoices({ patientId }) {
    const { rows } = await dosQuery(
      `select id, paid, dated_on, amount_pence from invoices where contact_id = $1`,
      [patientId],
    );
    return {
      items: rows.map((r) => ({
        id: String(r.id),
        paid: r.paid === true,
        paidOn: r.dated_on ? String(r.dated_on).slice(0, 10) : null,
        amountPennies: r.amount_pence ?? null,
      })),
    };
  },
};

// ---------- stub ----------
export const stubStore = { patients: [], appointments: [], invoices: [], nextId: 1, down: false };

export function stubReset() {
  stubStore.patients = [];
  stubStore.appointments = [];
  stubStore.invoices = [];
  stubStore.nextId = 1;
  stubStore.down = false;
}

export function stubAddPatient({ phone, siteId = null, updatedAt = new Date().toISOString() }) {
  const patient = { id: String(stubStore.nextId++), phone: normalizePhone(phone), siteId, updatedAt };
  stubStore.patients.push(patient);
  return patient;
}

/** One call = a patient (reused by phone if known) + a BOOKED future appointment. */
export function stubAddBookedAppointment({
  phone,
  siteId = null,
  startsAt = new Date(Date.now() + 2 * 86_400_000).toISOString(),
  updatedAt = new Date().toISOString(),
}) {
  const e164 = normalizePhone(phone);
  let patient = stubStore.patients.find((p) => p.phone === e164);
  if (!patient) patient = stubAddPatient({ phone, siteId, updatedAt });
  const appointment = {
    id: String(stubStore.nextId++),
    patientId: patient.id,
    siteId: siteId ?? patient.siteId,
    startsAt,
    cancelled: false,
    completedAt: null,
    updatedAt,
  };
  stubStore.appointments.push(appointment);
  return { patient, appointment };
}

/** One call = a patient (reused by phone if known) + a completed appointment + a paid invoice. */
export function stubAddCompletedTreatment({
  phone,
  siteId = null,
  amountPennies = 34000,
  completedAt = new Date().toISOString(),
  updatedAt = new Date().toISOString(),
  paid = true,
}) {
  const e164 = normalizePhone(phone);
  let patient = stubStore.patients.find((p) => p.phone === e164);
  if (!patient) patient = stubAddPatient({ phone, siteId, updatedAt });
  const appointment = {
    id: String(stubStore.nextId++),
    patientId: patient.id,
    siteId: siteId ?? patient.siteId,
    completedAt,
    updatedAt,
  };
  stubStore.appointments.push(appointment);
  if (paid) {
    stubStore.invoices.push({
      id: String(stubStore.nextId++),
      patientId: patient.id,
      paid: true,
      paidOn: completedAt.slice(0, 10),
      amountPennies,
    });
  }
  return { patient, appointment };
}

const assertUp = () => {
  if (stubStore.down) throw new Error('dentally_stub_down'); // simulates outage (matrix row 24)
};
const afterFilter = (items, updatedAfter) => items.filter((x) => x.updatedAt > updatedAfter);

const stubClient = {
  async listAppointments({ updatedAfter }) {
    assertUp();
    return { items: afterFilter(stubStore.appointments, updatedAfter), hasMore: false };
  },
  async listPatients({ updatedAfter }) {
    assertUp();
    return { items: afterFilter(stubStore.patients, updatedAfter), hasMore: false };
  },
  async getPatient(id) {
    assertUp();
    return stubStore.patients.find((p) => p.id === id) ?? null;
  },
  async listInvoices({ patientId }) {
    assertUp();
    return { items: stubStore.invoices.filter((i) => i.patientId === patientId) };
  },
};

export function dentallyClient(mode) {
  if (mode === 'dentalos') return dentalOsClient;
  return mode === 'live' ? liveClient : stubClient;
}
