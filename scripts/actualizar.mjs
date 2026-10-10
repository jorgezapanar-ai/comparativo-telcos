// Motor de lectura diaria de precios de competencia — comparativo de telcos (Claro / Movistar / Entel).
// Node >= 20. Requiere Playwright solo para Movistar (Cloudflare exige navegador real).
// Lee config.json (única fuente de verdad) y genera data.json en la raíz del repo.
// El panel (index.html) carga data.json y se configura a sí mismo con el config embebido.
import { readFile, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.join(DIR, '..');
const DATA = path.join(RAIZ, 'data.json');
const CFG = JSON.parse(await readFile(path.join(RAIZ, 'config.json'), 'utf8'));

const { monedaLocal, monedaExtranjera } = CFG;
const COD_LOC = monedaLocal.codigo;
const COD_EXT = monedaExtranjera.codigo;

const UA_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const UA_EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0';
let UA_ACTUAL = UA_CHROME;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const escRg = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const uaDe = (f) => (f?.ua === 'edge' ? UA_EDGE : UA_CHROME);

async function pedirGrande(url, tipo = 'text', timeoutMs = 30000) {
  // Fallback para respuestas con cabeceras/body gigantes donde undici lanza UND_ERR_HEADERS_OVERFLOW.
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpsRequest({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'GET',
      maxHeaderSize: 1024 * 1024,
      headers: {
        'User-Agent': UA_ACTUAL,
        'Accept-Language': `${monedaLocal.locale || 'es'},es;q=0.9`,
        Accept: tipo === 'json' ? 'application/json,text/plain,*/*' : 'text/html,application/xhtml+xml,*/*;q=0.8',
      },
    }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        if (r.statusCode >= 400) { reject(new Error(`HTTP ${r.statusCode}`)); return; }
        const body = Buffer.concat(chunks).toString('utf8');
        if (tipo === 'json') { try { resolve(JSON.parse(body)); } catch { reject(new Error('JSON inválido en ' + url)); } }
        else resolve(body);
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function pedir(url, tipo = 'text', intentos = 2) {
  let ultimo;
  for (let i = 0; i < intentos; i++) {
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': UA_ACTUAL,
          'Accept-Language': `${monedaLocal.locale || 'es'},es;q=0.9`,
          Accept: tipo === 'json' ? 'application/json,text/plain,*/*' : 'text/html,application/xhtml+xml,*/*;q=0.8',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      if (tipo === 'json') return await r.json();
      if (tipo === 'raw') return { status: r.status, texto: await r.text() };
      return await r.text();
    } catch (e) {
      ultimo = e;
      if (e?.cause?.code === 'UND_ERR_HEADERS_OVERFLOW') {
        try { return await pedirGrande(url, tipo); } catch (e2) { ultimo = e2; }
      }
      await dormir(800 * (i + 1));
    }
  }
  throw ultimo;
}

const num = (v) => {
  if (v == null) return null;
  const s = String(v).replace(/[^0-9.,]/g, '');
  if (!s) return null;
  const coma = s.lastIndexOf(',');
  const punto = s.lastIndexOf('.');
  let limpio;
  if (coma > -1 && punto > -1) {
    limpio = coma > punto ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (coma > -1) {
    const partes = s.split(',');
    limpio = partes.length > 2 || partes[1].length === 3 ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (punto > -1) {
    const partes = s.split('.');
    limpio = partes.length > 2 || partes[1].length === 3 ? s.replace(/\./g, '') : s;
  } else {
    limpio = s;
  }
  const n = Number(limpio);
  return isFinite(n) ? n : null;
};

function armar({ tienda, nombre, marca, precio, moneda, precioLista, disponible, url, imagen, categoria }) {
  const p = Math.round(Number(precio) * 100) / 100;
  if (!isFinite(p) || p <= 0) return null;
  const l = precioLista != null && isFinite(Number(precioLista)) && Number(precioLista) > p ? Math.round(Number(precioLista) * 100) / 100 : null;
  return {
    tienda,
    nombre: String(nombre || '').trim().replace(/\s+/g, ' '),
    marca: marca ? String(marca).trim().replace(/\s+/g, ' ') : null,
    precio: p,
    moneda: moneda || COD_LOC,
    precioLista: l,
    disponible: disponible === true ? true : disponible === false ? false : null,
    url: url || null,
    imagen: imagen || null,
    categoria: categoria || null,
  };
}

// ---------- Biblioteca de adaptadores (cada fuente en config.json declara su "tipo") ----------

async function leerVtex(fuente, params) {
  const { base, categorias = [], catId, catIds = [], excluir = [], paginasMax = 12, paso = 49, searchSub = '', orCategorias = false, agruparEquipo = false, quitarPlan = null } = params || {};
  // Agrupación de equipos: config nueva ("agrupar") o, por compatibilidad, los flags antiguos.
  const agruparCfg = params?.agrupar || (agruparEquipo ? { activo: true, quitarPlan } : null);
  const claveCampos = Array.isArray(agruparCfg?.clave) ? agruparCfg.clave : [];
  const patronCat = categorias.length ? new RegExp('\\/(' + categorias.map(escRg).join('|') + ')\\/', 'i') : null;
  const ids = catIds.length ? catIds : catId ? [catId] : [];
  const meta = { fuente: `${base.replace(/\/+$/, '')}/api/catalog_system/pub/products/search` };
  if (orCategorias && ids.length > 1) {
    const vistos = new Set();
    const productosOr = [];
    for (const id of ids) {
      const { productos: ps } = await leerVtex(fuente, { ...params, catIds: [id], orCategorias: false });
      for (const p of ps) { const k = p.url || p.nombre; if (vistos.has(k)) continue; vistos.add(k); productosOr.push(p); }
    }
    return { productos: agruparPorEquipo(productosOr, agruparCfg), meta };
  }
  const productos = [];
  let desde = 0;
  for (let p = 0; p < paginasMax; p++) {
    const fq = ids.length ? '&fq=' + ids.map((id) => 'C:/' + id + '/').join('&fq=') : '';
    const url = `${base}/api/catalog_system/pub/products/search${searchSub}?_from=${desde}&_to=${desde + paso}&O=OrderByPriceDESC${fq}`;
    let arr;
    try {
      arr = await pedir(url, 'json');
    } catch (e) {
      if (productos.length === 0) throw e;
      break;
    }
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const prod of arr) {
      const cats = prod.categories || [];
      const cat = patronCat ? cats.find((c) => patronCat.test(c)) : cats[0];
      if (!cat) continue;
      if (excluir.some((seg) => cat.toLowerCase().includes(seg.toLowerCase()))) continue;
      const item = (prod.items || [])[0];
      const off = item?.sellers?.[0]?.commertialOffer || {};
      const fila = armar({
        tienda: fuente.id,
        nombre: prod.productName || prod.productTitle,
        marca: prod.brand,
        precio: off.Price,
        moneda: params?.moneda || off.Currency || COD_LOC,
        precioLista: off.ListPrice,
        disponible: typeof off.IsAvailable === 'boolean' ? off.IsAvailable : null,
        url: prod.link,
        imagen: item?.images?.[0]?.imageUrl,
        categoria: cat,
      });
      if (fila) {
        // Especificaciones estructuradas del producto (VTEX) para identificar el equipo (modelo+capacidad+color).
        fila._lista = isFinite(Number(off.ListPrice)) ? Number(off.ListPrice) : null;
        fila._specs = {};
        for (const k of claveCampos) fila._specs[k] = Array.isArray(prod[k]) ? prod[k][0] : (prod[k] ?? null);
        productos.push(fila);
      }
    }
    if (!arr.length) break;
    desde += arr.length;
    await dormir(400);
  }
  return { productos: agruparPorEquipo(productos, agruparCfg), meta };
}

// Consolida el mismo equipo repetido por plan (VTEX de Claro lista una fila por combinación equipo+plan).
// Identifica el equipo por sus especificaciones (modelo+capacidad+color) o, si no hay, por el nombre
// sin el sufijo de plan. Conserva el MENOR precio de contado publicado, excluyendo las ofertas con
// subvención total por plan (precio muy por debajo del precio de lista). Si un equipo solo aparece
// con subvención total, se usa su precio de lista como valor del equipo.
function agruparPorEquipo(productos, cfg) {
  if (!cfg || cfg.activo === false) return productos;
  const rx = cfg.quitarPlan ? new RegExp(cfg.quitarPlan, 'i') : null;
  const campos = Array.isArray(cfg.clave) ? cfg.clave : [];
  const mostrar = Array.isArray(cfg.mostrar) ? cfg.mostrar : [];
  const pctMax = isFinite(cfg.subvencionMaxPct) ? Number(cfg.subvencionMaxPct) : 10;
  const grupos = new Map();
  for (const p of productos) {
    const limpio = rx ? String(p.nombre || '').replace(rx, '').trim().replace(/\s+/g, ' ') : p.nombre;
    const partes = campos.map((c) => p._specs?.[c]).filter((v) => v != null && v !== '');
    const clave = (partes.length ? partes.join('|') : String(limpio).toLowerCase()).toLowerCase();
    const fila = { ...p, nombre: limpio };
    const g = grupos.get(clave);
    if (g) g.filas.push(fila);
    else grupos.set(clave, { nombre: limpio, filas: [fila] });
  }
  const salida = [];
  for (const g of grupos.values()) {
    const conPrecio = g.filas.filter((f) => isFinite(f.precio) && f.precio > 0);
    const esReal = (f) => !(f._lista > 0) || f.precio >= f._lista * (pctMax / 100);
    const reales = conPrecio.filter(esReal);
    let base;
    if (reales.length) {
      base = reales.reduce((a, b) => (b.precio < a.precio ? b : a));
    } else if (conPrecio.length) {
      const conLista = conPrecio.reduce((a, b) => ((b._lista || 0) > (a._lista || 0) ? b : a));
      base = { ...conLista, precio: conLista._lista || conLista.precio, precioLista: null, _subvencionTotal: true };
    } else {
      base = g.filas[0];
    }
    const c = { ...base, nombre: g.nombre };
    // Completa el nombre con las especificaciones que el rótulo del operador omite (p. ej. capacidad).
    for (const campo of mostrar) {
      const v = base._specs?.[campo];
      if (v && !new RegExp(escRg(v), 'i').test(c.nombre)) c.nombre = `${c.nombre} ${v}`.trim();
    }
    if (!c._subvencionTotal && base._lista && base._lista > c.precio) c.precioLista = Math.round(base._lista * 100) / 100;
    salida.push(c);
  }
  return salida;
}

// Movistar (Magento 2) protege el catálogo con Cloudflare: el endpoint ajax responde 403 a
// clientes sin navegador. Se lee con un navegador real (headed) y se captura la respuesta
// del propio sitio (waitForResponse) o, si no, con un fetch dentro de la página.
async function leerMagentoAjax(fuente, params) {
  const { base, landing = '/celulares', endpoint = '/landing/ajax/products/', moneda, channel = 'msedge', headless = false } = params || {};
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error('Playwright no está instalado (ejecuta: npm install playwright && npx playwright install msedge)');
  }
  const canales = [...new Set([channel, 'msedge', 'chrome'].filter(Boolean))];
  const args = [
    '--disable-blink-features=AutomationControlled',
    '--window-position=-2400,-2400',
    '--window-size=1000,760',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
  ];
  let data = null;
  let ultimoError = null;
  for (const ch of canales) {
    let browser;
    try {
      browser = await chromium.launch({ headless: headless === true, channel: ch, args });
      const ctx = await browser.newContext({ locale: monedaLocal.locale || 'es-PE', viewport: { width: 1200, height: 820 } });
      const page = await ctx.newPage();
      let capt = null;
      page.on('response', async (r) => {
        if (r.url().includes(endpoint)) { try { const j = await r.json(); if (j && Array.isArray(j.products)) data = j; } catch { /* no json */ } }
      });
      await page.goto(base + landing, { waitUntil: 'domcontentloaded', timeout: 60000 });
      for (let i = 0; i < 15 && !data; i++) await page.waitForTimeout(1000);
      if (!data) {
        const via = await page.evaluate(async (ep) => {
          try {
            const r = await fetch(ep, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
            if (!r.ok) return { status: r.status };
            const j = await r.json();
            return { products: j.products || [] };
          } catch (e) { return { err: e.message }; }
        }, endpoint);
        if (via && via.products) data = { products: via.products };
        else ultimoError = new Error(`Movistar respondió ${via?.status || via?.err || 'sin datos'} (navegador ${ch})`);
      }
      await browser.close();
      if (data) break;
    } catch (e) {
      ultimoError = e;
      if (browser) { try { await browser.close(); } catch { /* ignorar */ } }
    }
  }
  if (!data) throw ultimoError || new Error('Movistar: no se pudo leer el endpoint ajax');
  const productos = [];
  for (const p of data.products || []) {
    const lista = num(p.price);
    const esp = num(p.special_price);
    const precio = esp && esp > 0 ? esp : lista;
    const v = (p.variant || [])[0] || {};
    const disponible = v.stock === true ? true : v.stock === false ? false : null;
    const fila = armar({
      tienda: fuente.id,
      nombre: p.name,
      marca: p.marca_text || p.marca || null,
      precio,
      moneda: moneda || COD_LOC,
      precioLista: lista && precio && lista > precio ? lista : null,
      disponible,
      url: p.url || null,
      imagen: p.image || null,
      categoria: 'Renovación postpago',
    });
    if (fila) productos.push(fila);
  }
  if (!productos.length) throw new Error('Movistar: 0 equipos con precio en el endpoint ajax');
  return { productos, meta: { categoria: 'Renovación postpago (equipo)', fuente: `${base}${endpoint} (Magento ajax, leído con navegador ${channel})` } };
}

// Entel (Oracle Endeca / Aaxis): el catálogo es HTML server-rendered con un JSON embebido en
// <script type="application/json">. Los productos viven en main[].records[].attributes
// (cada atributo es un arreglo). priceContadoRN = precio de equipo al contado del plan de renovación.
async function leerEndeca(fuente, params) {
  const { base, path: ruta, nrpp = 600, moneda } = params || {};
  const estado = (s) => {
    if (!s) return null;
    const t = String(s).toLowerCase().replace(/[^a-z]/g, '');
    if (t.includes('instock')) return true;
    if (t.includes('outofstock') || t.includes('backorder') || t.includes('preorder')) return false;
    return null;
  };
  const vistos = new Set();
  const productos = [];
  let total = null;
  let desde = 0;
  for (let p = 0; p < 60; p++) {
    const url = `${base}${ruta}?No=${desde}&Nrpp=${nrpp}`;
    const html = await pedir(url, 'text');
    const re = /<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let m; let blob = null; let best = 0;
    while ((m = re.exec(html))) { if (m[1].length > best) { best = m[1].length; blob = m[1]; } }
    if (!blob) throw new Error('Entel: sin bloque JSON embebido (Endeca) en la página');
    let j; try { j = JSON.parse(blob); } catch { throw new Error('Entel: JSON embebido inválido (Endeca)'); }
    const cont = (j.main || []).find((x) => Array.isArray(x?.records));
    if (!cont) throw new Error('Entel: estructura Endeca no reconocida (sin main[].records)');
    if (total == null) {
      const nr = j['endeca:assemblerRequestInformation']?.['endeca:numRecords'];
      total = isFinite(Number(nr)) ? Number(nr) : null;
    }
    const recs = cont.records;
    if (!recs.length) break;
    for (const r of recs) {
      const a = r.attributes || {};
      const av = (k) => (Array.isArray(a[k]) ? a[k][0] : a[k]);
      const pid = av('productId') || av('sku');
      const seo = av('seoUrl') || av('canonical');
      const img = av('productImage');
      const fila = armar({
        tienda: fuente.id,
        nombre: av('displayName'),
        marca: av('brand'),
        precio: num(av('priceContadoRN')),
        moneda: moneda || COD_LOC,
        precioLista: num(av('referencePriceContadoRN')),
        disponible: estado(av('inventoryStatus')),
        url: seo ? base + seo : null,
        imagen: img ? base + img : null,
        categoria: 'Renovación postpago',
      });
      if (fila && !vistos.has(pid)) { vistos.add(pid); productos.push(fila); }
    }
    desde += recs.length;
    if (total != null && desde >= total) break;
    if (recs.length < nrpp) break;
    await dormir(400);
  }
  if (!productos.length) throw new Error('Entel: 0 equipos con precio de equipo (contado) en el catálogo');
  return { productos, meta: { categoria: 'Renovación postpago (equipo)', fuente: `catálogo Endeca ${base}${ruta} (JSON embebido)` } };
}

// Sitio sin catálogo ni API: se reporta presencia/ausencia de precios en el HTML público.
async function leerEstatico(fuente, params) {
  const { base } = params || {};
  const html = await pedir(base, 'text');
  const patron = new RegExp(escRg(monedaLocal.simbolo) + '\\s?[\\d.,]+', 'g');
  const precios = html.match(patron) || [];
  return {
    productos: [],
    meta: {
      categoria: `Sitio institucional (${fuente.plataforma}) sin catálogo de precios`,
      fuente: 'HTML de la portada',
      nota: precios.length ? `Se detectaron ${precios.length} coincidencias de precio (${monedaLocal.simbolo}) en la portada.` : null,
    },
  };
}

// ---------- Tipo de cambio (para las fuentes que publican en la moneda de referencia) ----------
async function tipoCambio(previo) {
  try {
    const d = await pedir(`${CFG.apiFx}${COD_EXT}`, 'json');
    const tasa = d?.rates?.[COD_LOC];
    if (!isFinite(tasa)) throw new Error(`${COD_LOC} no disponible en ${CFG.apiFx}`);
    return { ok: true, tasa, monedaBase: COD_EXT, monedaLocal: COD_LOC, fuente: `${CFG.apiFx.replace(/\/+$/, '')} (tipo de cambio de referencia)`, obtenidoEn: new Date().toISOString() };
  } catch (e) {
    if (previo?.tasa) return { ...previo, ok: false, advertencia: `No se pudo actualizar el tipo de cambio: ${e.message}` };
    return { ok: false, tasa: null, monedaBase: COD_EXT, monedaLocal: COD_LOC, fuente: null, advertencia: `Sin tipo de cambio: ${e.message}` };
  }
}

// ---------- Revalidación diaria de la política de entrega (base declarada en config.envios) ----------
async function validarEnvios(previo) {
  const prevHash = Object.fromEntries((previo?.envios || []).map((e) => [e.tienda, e.hash]));
  const salida = [];
  for (const e of CFG.envios) {
    const fila = { ...e, verificadoEn: new Date().toISOString(), estado: 'ok', hash: null, cambioDetectado: false };
    try {
      const r = await fetch(e.fuente, { headers: { 'User-Agent': UA_CHROME, 'Accept-Language': 'es-PE,es;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
      const texto = await r.text();
      const limpio = texto.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      fila.hash = Buffer.from(limpio).toString('base64').slice(0, 24);
      fila.cambioDetectado = !!(prevHash[e.tienda] && prevHash[e.tienda] !== fila.hash);
    } catch (err) {
      fila.estado = 'error';
    }
    salida.push(fila);
  }
  return salida;
}

const ADAPTADORES = {
  vtex: leerVtex,
  'magento-ajax': leerMagentoAjax,
  'endeca-json': leerEndeca,
  estatico: leerEstatico,
};

const FUENTES = CFG.fuentes.map((f) => {
  const correr = ADAPTADORES[f.tipo];
  if (!correr) throw new Error(`Tipo de adaptador no reconocido: "${f.tipo}" (fuente ${f.id}).`);
  return { ...f, correr };
});

// ---------- Lectura ----------
const inicio = Date.now();
let previo = null;
try { previo = JSON.parse(await readFile(DATA, 'utf8')); } catch { previo = null; }

const fuentes = [];
const productos = [];
for (const f of FUENTES) {
  const registro = {
    id: f.id, nombre: f.nombre, rol: f.rol, url: f.url, plataforma: f.plataforma, segmento: f.segmento || null,
    estado: 'ok', error: null, productos: 0, categoria: null, fuenteDato: null, nota: null,
    leidoEn: new Date().toISOString(), datosDe: null,
  };
  try {
    const { productos: ps, meta } = await f.correr(f, f.params || {});
    registro.productos = ps.length;
    registro.categoria = meta.categoria || f.segmento || null;
    registro.fuenteDato = meta.fuente || null;
    registro.nota = meta.nota || null;
    productos.push(...ps);
  } catch (e) {
    const previos = (previo?.productos || []).filter((p) => p.tienda === f.id);
    registro.estado = previos.length ? 'error' : 'vacio';
    registro.error = e.message;
    registro.productos = previos.length;
    registro.datosDe = previo?.generadoEn || null;
    productos.push(...previos);
  }
  fuentes.push(registro);
  await dormir(500);
}

const fx = await tipoCambio(previo?.fx);
for (const p of productos) {
  if (p.moneda === COD_EXT) {
    if (fx.tasa) { p.precioOriginal = p.precio; p.precio = Math.round(p.precio * fx.tasa * 100) / 100; p.moneda = COD_LOC; p.convertido = true; }
    else { p.noComparable = true; }
  }
}

// Segmento = marca (config.segmentos). Regla de etiquetado, no categoría oficial del operador.
const SEGMENTOS = CFG.segmentos || [];
for (const p of productos) {
  const txt = String(p.marca || p.nombre || p.categoria || '');
  const n = txt.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  const m = SEGMENTOS.find((s) => (s.patrones || []).some((pat) => n.includes(pat)));
  p.segmento = m ? m.id : 'sin-segmento';
}

// Limpia campos internos usados solo durante la lectura/consolidación.
for (const p of productos) { delete p._lista; delete p._specs; delete p._subvencionTotal; }

const envios = await validarEnvios(previo);

const conPrecio = productos.filter((p) => isFinite(p.precio) && p.precio > 0);
const salida = {
  generadoEn: new Date().toISOString(),
  duracionMs: Date.now() - inicio,
  config: CFG,
  resumen: {
    productos: conPrecio.length,
    fuentesOk: fuentes.filter((f) => f.estado === 'ok').length,
    fuentesTotal: fuentes.length,
    convertidos: productos.filter((p) => p.convertido).length,
    sinPrecio: productos.filter((p) => p.noComparable).length,
    conDescuento: productos.filter((p) => p.precioLista).length,
  },
  fx,
  fuentes,
  envios,
  productos,
};

await writeFile(DATA, JSON.stringify(salida), 'utf8');
console.log(`OK: ${salida.resumen.productos} equipos · ${salida.resumen.fuentesOk}/${salida.resumen.fuentesTotal} fuentes · ${salida.duracionMs} ms`);
for (const f of fuentes) console.log(`  - ${f.nombre}: ${f.estado} · ${f.productos} equipos${f.error ? ' · ' + f.error : ''}`);
if (salida.resumen.fuentesOk === 0) process.exit(1);
