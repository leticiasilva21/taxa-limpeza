// limpeza-taxas
//
// Backend do app "Reajuste da Taxa de Limpeza". Lê a taxa de limpeza de cada anúncio direto da Stays
// (/settings/listing/{id}/sellprice → fees[] "Cleaning Fee"), cruza com a ocupação dos grupos de preço
// (cache do app Performance de Diárias, RPC pricing_limpeza_groups) e grava o reajuste aprovado de volta
// na Stays — no pai de preço e em todos os anúncios/unidades que dependem dele.
// Credenciais da Stays ficam só aqui. Login: mesmo do "Ajuste de Tarifa por Período".
//
// Ações (POST { action, ... }, Authorization: Bearer <token de sessão>):
//   "data"   -> grupos + ocupação + taxa atual de cada anúncio + histórico de alterações.
//   "sync"   -> { ids? } relê a taxa de limpeza na Stays (todos os anúncios conhecidos, em lotes).
//   "apply"  -> { items: [{ group, value }] } grava a nova taxa no pai e nos membros do grupo.
//   "revert" -> { ids } volta as alterações do log para o valor anterior.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STAYS_BASE_URL = (Deno.env.get("STAYS_BASE_URL") ?? "").replace(/\/$/, "");
const STAYS_AUTH_BASIC = Deno.env.get("STAYS_AUTH_BASIC") ?? "";

const FEE_NAME = "Cleaning Fee";
const MAX_FEE = 2000; // trava contra digitação errada
const MAX_GROUPS_PER_APPLY = 40;

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function json(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function staysUrl(path: string): string {
  const hasV1 = /\/external\/v1$/.test(STAYS_BASE_URL);
  return hasV1 ? `${STAYS_BASE_URL}${path}` : `${STAYS_BASE_URL}/external/v1${path}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function stays(method: string, path: string, body?: unknown): Promise<any> {
  let lastErr = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const resp = await fetch(staysUrl(path), {
        method,
        headers: {
          Authorization: `Basic ${STAYS_AUTH_BASIC}`,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await resp.text();
      if (resp.ok) return text ? JSON.parse(text) : null;
      lastErr = `${method} ${path} -> ${resp.status}: ${text.slice(0, 300)}`;
      if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) throw new Error(lastErr);
    } catch (e) {
      lastErr = String((e as Error)?.message ?? e);
      if (/-> 4\d\d/.test(lastErr) && !/-> 429/.test(lastErr)) throw e;
    }
    await sleep(800 * (attempt + 1));
  }
  throw new Error(lastErr);
}

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

function must<T>(res: { data: T; error: any }): T {
  if (res.error) throw new Error(`banco: ${res.error.message ?? JSON.stringify(res.error)}`);
  return res.data;
}

function todayBR(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
}

async function requireSession(req: Request): Promise<string | null> {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(token)) return null;
  const { data } = await db
    .from("tarifa_periodo_sessions")
    .select("email, expires_at")
    .eq("token", token)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  return data?.email ?? null;
}

// Lê a taxa de limpeza de um anúncio na Stays.
async function readFee(id: string) {
  const sp = await stays("GET", `/settings/listing/${id}/sellprice`);
  const f = (sp?.fees ?? []).find((x: any) => x.internalName === FEE_NAME);
  if (!f) return null;
  return { listing_id: id, fee_id: f._id, val: f._f_val ?? null, use_global: !!f.useGlobalSettings, raw: f };
}
const cacheRow = (f: any) => ({ listing_id: f.listing_id, fee_id: f.fee_id, val: f.val, use_global: f.use_global, synced_at: new Date().toISOString() });

// A Stays exige o objeto da taxa completo (type, chargeType…); só _id/_f_val dá 400 "invalid type".
// Mandar só a taxa de limpeza preserva as demais (validado em 15/10/2026).
async function writeFee(id: string, raw: any, val: number, useGlobal = false) {
  const { _mstitle, ...fee } = raw;
  await stays("PATCH", `/settings/listing/${id}/sellprice`, {
    fees: [{ ...fee, _f_val: val, useGlobalSettings: useGlobal }],
  });
}

async function loadAll(table: string, select: string) {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const rows = must(await db.from(table).select(select).range(from, from + 999)) as any[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

// ---------- ações ----------

async function actionData() {
  const [groups, fees, changes, sync] = await Promise.all([
    db.rpc("pricing_limpeza_groups", { p_today: todayBR() }),
    loadAll("pricing_limpeza_fees", "listing_id, val, use_global, synced_at"),
    db.from("pricing_limpeza_changes").select("*").order("at", { ascending: false }).limit(3000),
    db.from("pricing_perf_sync").select("finished_at").eq("id", 1).maybeSingle(),
  ]);
  const feeMap: Record<string, [number | null, boolean]> = {};
  let feesAt = "";
  for (const f of fees) {
    feeMap[f.listing_id] = [f.val == null ? null : Number(f.val), f.use_global];
    if (f.synced_at > feesAt) feesAt = f.synced_at;
  }
  return {
    today: todayBR(),
    groups: must(groups),
    fees: feeMap,
    feesAt,
    occAt: sync.data?.finished_at ?? null,
    changes: must(changes),
  };
}

async function actionSync(body: any) {
  let ids: string[] = body.ids ?? [];
  if (!ids.length) {
    const rows = await loadAll("pricing_perf_listings", "id, status");
    ids = rows.filter((r: any) => r.status === "active" || r.status === "hidden").map((r: any) => r.id);
    return { ids }; // o front lê em lotes
  }
  ids = ids.slice(0, 120);
  const now = new Date().toISOString();
  const rows = await pool(ids, 5, async (id) => {
    try {
      const f = await readFee(id);
      return f ? { ...cacheRow(f), synced_at: now } : null;
    } catch {
      return null;
    }
  });
  const ok = rows.filter(Boolean) as any[];
  if (ok.length) must(await db.from("pricing_limpeza_fees").upsert(ok));
  return { done: ok.length, failed: ids.length - ok.length };
}

async function actionApply(body: any, email: string) {
  const items: { group: string; value: number }[] = (body.items ?? []).slice(0, MAX_GROUPS_PER_APPLY);
  if (!items.length) return { results: [] };
  const groups = must(await db.rpc("pricing_limpeza_groups", { p_today: todayBR() })) as any[];
  const byId = new Map(groups.map((g) => [g.id, g]));

  const results: any[] = [];
  for (const it of items) {
    const g = byId.get(it.group);
    const value = Math.round(Number(it.value) * 100) / 100;
    if (!g) { results.push({ group: it.group, ok: false, error: "grupo não encontrado" }); continue; }
    if (!isFinite(value) || value <= 0 || value > MAX_FEE) {
      results.push({ group: it.group, ok: false, error: `valor inválido: ${it.value}` });
      continue;
    }
    // Pai de preço primeiro, depois quem clona dele (anúncios vendáveis e unidades do prédio).
    const ids: string[] = [g.id, ...(g.ads ?? []).map((a: any) => a.id).filter((id: string) => id !== g.id)];
    const per = await pool(ids, 4, async (id) => {
      let before: any = null;
      try {
        before = await readFee(id);
        if (!before) throw new Error("anúncio sem taxa de limpeza configurada");
        // Nunca reduz: se o anúncio já cobra mais que o valor do grupo, fica como está.
        if (before.val != null && Number(before.val) >= value && !before.use_global) {
          return { id, ok: true, skipped: true, old: before.val };
        }
        await writeFee(id, before.raw, value);
        const after = await readFee(id);
        const ok = after && Number(after.val) === value && !after.use_global;
        if (after) await db.from("pricing_limpeza_fees").upsert(cacheRow(after));
        const err = ok ? null : `Stays devolveu ${after?.val ?? "?"}${after?.use_global ? " (global)" : ""}`;
        await db.from("pricing_limpeza_changes").insert({
          email, listing_id: id, group_id: g.id, old_val: before.val, old_global: before.use_global,
          new_val: value, ok, error: err,
        });
        return { id, ok, error: err, old: before.val };
      } catch (e) {
        const err = String((e as Error)?.message ?? e);
        await db.from("pricing_limpeza_changes").insert({
          email, listing_id: id, group_id: g.id, old_val: before?.val ?? null, old_global: before?.use_global ?? null,
          new_val: value, ok: false, error: err,
        });
        return { id, ok: false, error: err };
      }
    });
    results.push({ group: g.id, value, ok: per.every((p) => p.ok), listings: per });
  }
  return { results };
}

async function actionRevert(body: any, email: string) {
  const ids: number[] = (body.ids ?? []).slice(0, 300);
  const rows = must(await db.from("pricing_limpeza_changes").select("*").in("id", ids).is("reverted_at", null)) as any[];
  const res = await pool(rows, 4, async (c) => {
    try {
      const cur = await readFee(c.listing_id);
      if (!cur) throw new Error("taxa não encontrada");
      if (c.old_global) await writeFee(c.listing_id, cur.raw, Number(c.old_val ?? cur.val), true);
      else await writeFee(c.listing_id, cur.raw, Number(c.old_val), false);
      const after = await readFee(c.listing_id);
      if (after) await db.from("pricing_limpeza_fees").upsert(cacheRow(after));
      await db.from("pricing_limpeza_changes").update({ reverted_at: new Date().toISOString() }).eq("id", c.id);
      return { id: c.id, ok: true };
    } catch (e) {
      return { id: c.id, ok: false, error: String((e as Error)?.message ?? e) };
    }
  });
  return { results: res, by: email };
}

// Redefinir a senha do login compartilhado (tarifa_periodo_login), sem sessão. Prova de identidade:
// a senha atual desse login OU a senha da conta Supabase Auth (Carpediem) do mesmo e-mail.
// Encerra as sessões abertas desse e-mail.
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const GENERIC_FAIL = "E-mail ou senha de confirmação incorretos.";

async function actionResetPassword(body: any) {
  const email = String(body.email ?? "").trim().toLowerCase();
  const proof = String(body.proof ?? "");
  const pw = String(body.newPassword ?? "");
  if (!email || !proof) return { ok: false, error: "Preencha o e-mail e a senha de confirmação." };
  if (pw.length < 8) return { ok: false, error: "A senha nova precisa ter pelo menos 8 caracteres." };
  const { data: known } = await db.from("tarifa_periodo_login").select("email").ilike("email", email).maybeSingle();
  if (!known) { await sleep(1200); return { ok: false, error: GENERIC_FAIL }; }

  // 1) senha atual deste login (a RPC abre uma sessão; é apagada logo abaixo junto com as demais)
  const { data: tok } = await db.rpc("tarifa_periodo_login", { p_email: email, p_password: proof });
  let verified = typeof tok === "string" && !!tok;
  // 2) senha da conta Carpediem no Supabase Auth
  if (!verified && ANON_KEY) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: proof }),
    });
    verified = r.ok;
  }
  if (!verified) { await sleep(1200); return { ok: false, error: GENERIC_FAIL }; }
  must(await db.rpc("tarifa_periodo_set_password", { p_email: email, p_password: pw }));
  return { ok: true };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (!STAYS_BASE_URL || !STAYS_AUTH_BASIC) {
    return json(500, { error: "STAYS_BASE_URL/STAYS_AUTH_BASIC não configurados nesta função" });
  }
  try {
    const body = await req.json().catch(() => ({}));
    if (body.action === "reset_password") return json(200, await actionResetPassword(body));
    const email = await requireSession(req);
    if (!email) return json(401, { error: "sessão inválida" });
    switch (body.action) {
      case "data": return json(200, await actionData());
      case "sync": return json(200, await actionSync(body));
      case "apply": return json(200, await actionApply(body, email));
      case "revert": return json(200, await actionRevert(body, email));
      default: return json(400, { error: "ação desconhecida" });
    }
  } catch (e) {
    return json(500, { error: String((e as Error)?.message ?? e) });
  }
});
